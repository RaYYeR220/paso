//! Paso account.
//!
//! A Stellar contract account that belongs to one Ethereum address. It holds
//! no Stellar key: every authorisation is an EIP-712 signature made by the
//! owner's Ethereum key.
//!
//! The signed message is rebuilt here, on chain, from the calls the host is
//! about to authorise. A wallet shows that message to the owner as readable
//! text, so a signature only ever authorises the calls that were displayed.

#![no_std]

mod eip712;
mod render;

#[cfg(test)]
mod audit;
#[cfg(test)]
mod test;

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl,
    crypto::Hash,
    symbol_short,
    unwrap::UnwrapOptimized,
    Bytes, BytesN, Env, Symbol, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AccountError {
    /// Only contract calls can be authorised.
    UnsupportedContext = 1,
    /// Not signed by the owner over these exact calls.
    BadSignature = 2,
    /// The last signature byte must be 0, 1, 27 or 28.
    BadRecoveryId = 3,
}

const OWNER: Symbol = symbol_short!("owner");

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
pub struct PasoAccount;

#[contractimpl]
impl PasoAccount {
    /// Binds the account to its owner's Ethereum address, for good.
    pub fn __constructor(env: Env, owner: BytesN<20>) {
        env.storage().instance().set(&OWNER, &owner);
    }

    /// The Ethereum address that controls the account.
    pub fn owner(env: Env) -> BytesN<20> {
        env.storage().instance().get(&OWNER).unwrap_optimized()
    }
}

#[contractimpl]
impl CustomAccountInterface for PasoAccount {
    /// `r ‖ s ‖ v`, with `s` in the lower half of the curve order and `v`
    /// one of 0, 1, 27 or 28.
    type Signature = BytesN<65>;
    type Error = AccountError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<65>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let digest = eip712::digest(&env, &signature_payload.to_bytes(), &auth_contexts)?;

        let signature = Bytes::from(signature);
        let recovery_id = match signature.get_unchecked(64) {
            0 | 27 => 0,
            1 | 28 => 1,
            _ => return Err(AccountError::BadRecoveryId),
        };

        // The host aborts on scalars it cannot use, so they are refused here
        // first: `r` must lie in [1, n) and `s` in [1, n / 2], which also
        // rules out the mirrored form of a signature. Byte strings of equal
        // length compare as big-endian numbers.
        let r = signature.slice(..32);
        let s = signature.slice(32..64);
        let zero = Bytes::from_array(&env, &[0; 32]);
        if r == zero
            || r >= Bytes::from_array(&env, &CURVE_ORDER)
            || s == zero
            || s > Bytes::from_array(&env, &HALF_CURVE_ORDER)
        {
            return Err(AccountError::BadSignature);
        }

        let r_and_s = BytesN::try_from(signature.slice(..64)).unwrap_optimized();
        let public_key = env
            .crypto()
            .secp256k1_recover(&digest, &r_and_s, recovery_id);

        // An Ethereum address is the last 20 bytes of the keccak hash of the
        // public key, taken without its leading 0x04 byte.
        let key_hash = env.crypto().keccak256(&Bytes::from(public_key).slice(1..));
        let signer = Bytes::from(key_hash.to_bytes()).slice(12..);
        if signer != Bytes::from(Self::owner(env)) {
            return Err(AccountError::BadSignature);
        }
        Ok(())
    }
}
