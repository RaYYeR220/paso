//! Paso EVM verifier.
//!
//! A signature verifier for OpenZeppelin's Stellar smart accounts. An account
//! that lists `External(<this contract>, <20-byte Ethereum address>)` among
//! its signers accepts secp256k1 signatures made by that address.
//!
//! The account hands the verifier 32 bytes and nothing else, so that is all a
//! signature covers: the wallet shows an EIP-712 message holding one hash, not
//! the calls behind it. What the hash commits to is decided by the account.
//!
//! The contract keeps no state and has no constructor and no privileged
//! function. One deployment serves any number of accounts.

#![no_std]

mod eip712;

#[cfg(test)]
mod account_test;
#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contracterror, contractimpl, panic_with_error, unwrap::UnwrapOptimized, Bytes,
    BytesN, Env, Vec,
};
use stellar_accounts::verifiers::Verifier;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EvmVerifierError {
    /// The payload to verify is not 32 bytes long.
    BadPayloadLength = 1,
    /// `r` or `s` is zero or too large, or `s` is in the upper half of the
    /// curve order.
    BadSignature = 2,
    /// The last signature byte must be 0, 1, 27 or 28.
    BadRecoveryId = 3,
}

/// Order of the secp256k1 group.
const CURVE_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// Half the group order, rounded down: the largest `s` a signature may carry.
const HALF_CURVE_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

#[contract]
pub struct EvmVerifier;

#[contractimpl]
impl Verifier for EvmVerifier {
    /// An Ethereum address.
    type KeyData = BytesN<20>;
    /// `r ‖ s ‖ v`, with `s` in the lower half of the curve order and `v`
    /// one of 0, 1, 27 or 28.
    type SigData = BytesN<65>;

    /// Whether `sig_data` is the signature of the address `key_data` over the
    /// EIP-712 message that carries `hash` on this network.
    ///
    /// Returns `false` for a well-formed signature made by any other key, or
    /// over any other payload or network. A malformed input is an error
    /// instead: [`EvmVerifierError`] for a payload that is not 32 bytes, a
    /// bad recovery byte and `r` or `s` out of range; a host error for key
    /// data that is not 20 bytes, signature data that is not 65 bytes and an
    /// `r` that is not the x-coordinate of a curve point.
    fn verify(e: &Env, hash: Bytes, key_data: BytesN<20>, sig_data: BytesN<65>) -> bool {
        let Ok(payload) = BytesN::<32>::try_from(hash) else {
            panic_with_error!(e, EvmVerifierError::BadPayloadLength)
        };
        let digest = eip712::digest(e, &payload);

        let signature = Bytes::from(sig_data);
        let recovery_id = match signature.get_unchecked(64) {
            0 | 27 => 0,
            1 | 28 => 1,
            _ => panic_with_error!(e, EvmVerifierError::BadRecoveryId),
        };

        // The host aborts on scalars it cannot use, so they are refused here
        // first: `r` must lie in [1, n) and `s` in [1, n / 2], which also
        // rules out the mirrored form of a signature. Byte strings of equal
        // length compare as big-endian numbers.
        let r = signature.slice(..32);
        let s = signature.slice(32..64);
        let zero = Bytes::from_array(e, &[0; 32]);
        if r == zero
            || r >= Bytes::from_array(e, &CURVE_ORDER)
            || s == zero
            || s > Bytes::from_array(e, &HALF_CURVE_ORDER)
        {
            panic_with_error!(e, EvmVerifierError::BadSignature)
        }

        let r_and_s = BytesN::try_from(signature.slice(..64)).unwrap_optimized();
        let public_key = e.crypto().secp256k1_recover(&digest, &r_and_s, recovery_id);

        // An Ethereum address is the last 20 bytes of the keccak hash of the
        // public key, taken without its leading 0x04 byte.
        let key_hash = e.crypto().keccak256(&Bytes::from(public_key).slice(1..));
        Bytes::from(key_hash.to_bytes()).slice(12..) == Bytes::from(key_data)
    }

    /// The address itself: 20 bytes name one address and no other 20 bytes
    /// name the same one.
    fn canonicalize_key(_e: &Env, key_data: BytesN<20>) -> Bytes {
        key_data.into()
    }

    /// [`Verifier::canonicalize_key`] for each key, in the order given.
    fn batch_canonicalize_key(e: &Env, key_data: Vec<BytesN<20>>) -> Vec<Bytes> {
        Vec::from_iter(e, key_data.iter().map(Bytes::from))
    }
}
