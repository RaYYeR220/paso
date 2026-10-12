//! EIP-712 hashing of the message the owner signs.
//!
//! ```text
//! EIP712Domain(string name,string version,bytes32 salt)
//!     name = "Paso", version = "1", salt = network id
//!
//! Authorization(string account,Call[] calls,bytes32 payload)
//! Call(string contract,string fn,string[] args)
//! ```
//!
//! `account` is the address of this contract. `calls` holds one entry per
//! call being authorised, in the order the host lists them: the root call
//! first, then its sub-calls depth first. `payload` is the Soroban
//! authorisation payload, which already commits to the network, the nonce,
//! the expiry ledger and the whole invocation tree.
//!
//! There is no chain id and no verifying contract in the domain. The network
//! is bound by the salt and the account by the `account` field.

use soroban_sdk::{auth::Context, crypto::Hash, Bytes, BytesN, Env, Vec};

use crate::{render, AccountError};

/// keccak256("EIP712Domain(string name,string version,bytes32 salt)")
pub const DOMAIN_TYPE_HASH: [u8; 32] = [
    0x59, 0x9a, 0x80, 0xfc, 0xaa, 0x47, 0xb9, 0x5e, 0x23, 0x23, 0xab, 0x4d, 0x34, 0xd3, 0x4e, 0x0c,
    0xc9, 0xfe, 0xda, 0x4b, 0x84, 0x3e, 0xda, 0xfc, 0xc3, 0x0c, 0x7b, 0xdf, 0x60, 0xea, 0x15, 0xbf,
];

/// keccak256("Paso")
pub const NAME_HASH: [u8; 32] = [
    0x2b, 0xcd, 0xe5, 0x8e, 0x66, 0x14, 0x0b, 0xe1, 0xcc, 0x0a, 0x67, 0xcf, 0xad, 0xbb, 0x9c, 0x05,
    0xab, 0xd4, 0xea, 0x7f, 0xc7, 0xa8, 0x73, 0xce, 0x26, 0x44, 0xf6, 0x6b, 0x61, 0x3c, 0x0b, 0x7c,
];

/// keccak256("1")
pub const VERSION_HASH: [u8; 32] = [
    0xc8, 0x9e, 0xfd, 0xaa, 0x54, 0xc0, 0xf2, 0x0c, 0x7a, 0xdf, 0x61, 0x28, 0x82, 0xdf, 0x09, 0x50,
    0xf5, 0xa9, 0x51, 0x63, 0x7e, 0x03, 0x07, 0xcd, 0xcb, 0x4c, 0x67, 0x2f, 0x29, 0x8b, 0x8b, 0xc6,
];

/// keccak256("Authorization(string account,Call[] calls,bytes32 payload)Call(string contract,string fn,string[] args)")
pub const AUTHORIZATION_TYPE_HASH: [u8; 32] = [
    0xa2, 0x05, 0xb4, 0x54, 0x30, 0x6e, 0x7b, 0x38, 0x64, 0x90, 0x93, 0xdf, 0x85, 0xce, 0x38, 0xa6,
    0x88, 0x71, 0x4f, 0x1a, 0xb3, 0x7a, 0x79, 0x7c, 0xb5, 0x5e, 0xe6, 0x1c, 0x17, 0xd2, 0x40, 0xea,
];

/// keccak256("Call(string contract,string fn,string[] args)")
pub const CALL_TYPE_HASH: [u8; 32] = [
    0x2f, 0x39, 0x0a, 0xa1, 0x44, 0xe2, 0xef, 0xdb, 0x32, 0x4e, 0x5f, 0x3f, 0xf9, 0x5c, 0xd7, 0xdb,
    0xa2, 0xd4, 0x3c, 0x8e, 0xe1, 0x04, 0x3a, 0x4c, 0x4f, 0x77, 0x69, 0x11, 0xd4, 0xad, 0xf0, 0x17,
];

/// The digest the owner signs to authorise `contexts` under `payload`.
///
/// Fails with [`AccountError::UnsupportedContext`] if any context is not a
/// contract call.
pub fn digest(
    env: &Env,
    payload: &BytesN<32>,
    contexts: &Vec<Context>,
) -> Result<Hash<32>, AccountError> {
    let mut calls = Bytes::new(env);
    for context in contexts.iter() {
        let Context::Contract(call) = context else {
            return Err(AccountError::UnsupportedContext);
        };

        let mut args = Bytes::new(env);
        for arg in call.args.iter() {
            args.append(&keccak(env, &render::text(env, &arg)));
        }

        let mut encoded = Bytes::from_array(env, &CALL_TYPE_HASH);
        encoded.append(&keccak(env, &render::address(&call.contract)));
        encoded.append(&keccak(env, &render::text(env, call.fn_name.as_val())));
        encoded.append(&keccak(env, &args));
        calls.append(&keccak(env, &encoded));
    }

    let mut message = Bytes::from_array(env, &AUTHORIZATION_TYPE_HASH);
    message.append(&keccak(
        env,
        &render::address(&env.current_contract_address()),
    ));
    message.append(&keccak(env, &calls));
    message.append(payload.as_ref());

    let mut domain = Bytes::from_array(env, &DOMAIN_TYPE_HASH);
    domain.extend_from_array(&NAME_HASH);
    domain.extend_from_array(&VERSION_HASH);
    domain.append(env.ledger().network_id().as_ref());

    let mut preimage = Bytes::from_array(env, &[0x19, 0x01]);
    preimage.append(&keccak(env, &domain));
    preimage.append(&keccak(env, &message));
    Ok(env.crypto().keccak256(&preimage))
}

fn keccak(env: &Env, data: &Bytes) -> Bytes {
    env.crypto().keccak256(data).to_bytes().into()
}
