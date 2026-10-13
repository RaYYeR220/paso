//! EIP-712 hashing of the message a signer signs.
//!
//! ```text
//! EIP712Domain(string name,string version,bytes32 salt)
//!     name = "Paso verifier", version = "2", salt = network id
//!
//! Authorization(string account,bytes32 payload)
//! ```
//!
//! `account` is the strkey (`C…`) of the smart account the signer was
//! registered for, rendered here from the contract id in the key data.
//! `payload` is the 32 bytes the smart account asks the verifier to check.
//!
//! There is no chain id and no verifying contract in the domain. The network
//! is bound by the salt and the account by the `account` field. The domain
//! name differs from the one Paso's own account uses, so a signature made for
//! one is never valid for the other.

use soroban_sdk::{
    crypto::Hash, unwrap::UnwrapOptimized, xdr::FromXdr, Address, Bytes, BytesN, Env,
};

/// keccak256("EIP712Domain(string name,string version,bytes32 salt)")
pub const DOMAIN_TYPE_HASH: [u8; 32] = [
    0x59, 0x9a, 0x80, 0xfc, 0xaa, 0x47, 0xb9, 0x5e, 0x23, 0x23, 0xab, 0x4d, 0x34, 0xd3, 0x4e, 0x0c,
    0xc9, 0xfe, 0xda, 0x4b, 0x84, 0x3e, 0xda, 0xfc, 0xc3, 0x0c, 0x7b, 0xdf, 0x60, 0xea, 0x15, 0xbf,
];

/// keccak256("Paso verifier")
pub const NAME_HASH: [u8; 32] = [
    0x65, 0x8f, 0xc3, 0x4f, 0x7f, 0x7c, 0x98, 0x8b, 0x66, 0xc2, 0x81, 0x82, 0xe1, 0xb3, 0x5d, 0x54,
    0x03, 0xce, 0xa6, 0x60, 0x03, 0xe7, 0xef, 0x74, 0xf9, 0xa2, 0x4c, 0x30, 0x96, 0xe2, 0x4c, 0x12,
];

/// keccak256("2")
pub const VERSION_HASH: [u8; 32] = [
    0xad, 0x7c, 0x5b, 0xef, 0x02, 0x78, 0x16, 0xa8, 0x00, 0xda, 0x17, 0x36, 0x44, 0x4f, 0xb5, 0x8a,
    0x80, 0x7e, 0xf4, 0xc9, 0x60, 0x3b, 0x78, 0x48, 0x67, 0x3f, 0x7e, 0x3a, 0x68, 0xeb, 0x14, 0xa5,
];

/// keccak256("Authorization(string account,bytes32 payload)")
pub const AUTHORIZATION_TYPE_HASH: [u8; 32] = [
    0xd6, 0x62, 0x61, 0x7b, 0x89, 0xa7, 0xa4, 0xef, 0x5f, 0x9e, 0x73, 0x91, 0x36, 0x43, 0xf1, 0x86,
    0xba, 0xbe, 0xa9, 0xb7, 0x10, 0x1d, 0xb8, 0xe2, 0x80, 0xf6, 0x59, 0x66, 0xce, 0x8d, 0x31, 0x68,
];

/// The XDR of a contract address up to the contract id: the tags of
/// `ScVal::Address` and `ScAddress::Contract`.
const CONTRACT_ADDRESS_XDR_HEAD: [u8; 8] = [0, 0, 0, 18, 0, 0, 0, 1];

/// Strkey (`C…`) of the contract with this id, as a wallet displays it.
pub fn account_text(env: &Env, account: &BytesN<32>) -> Bytes {
    // Every 32 bytes are the id of some contract address, so this cannot fail.
    let mut xdr = Bytes::from_array(env, &CONTRACT_ADDRESS_XDR_HEAD);
    xdr.append(account.as_ref());
    Address::from_xdr(env, &xdr)
        .unwrap_optimized()
        .to_string()
        .to_bytes()
}

/// The digest a signer signs to approve `payload` for the account with the
/// contract id `account`, on the current network.
pub fn digest(env: &Env, account: &BytesN<32>, payload: &BytesN<32>) -> Hash<32> {
    let mut domain = Bytes::from_array(env, &DOMAIN_TYPE_HASH);
    domain.extend_from_array(&NAME_HASH);
    domain.extend_from_array(&VERSION_HASH);
    domain.append(env.ledger().network_id().as_ref());

    let mut message = Bytes::from_array(env, &AUTHORIZATION_TYPE_HASH);
    message.append(&keccak(env, &account_text(env, account)));
    message.append(payload.as_ref());

    let mut preimage = Bytes::from_array(env, &[0x19, 0x01]);
    preimage.append(&keccak(env, &domain));
    preimage.append(&keccak(env, &message));
    env.crypto().keccak256(&preimage)
}

fn keccak(env: &Env, data: &Bytes) -> Bytes {
    env.crypto().keccak256(data).to_bytes().into()
}
