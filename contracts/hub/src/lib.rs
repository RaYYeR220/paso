//! Paso hub.
//!
//! Two jobs, neither of which needs an administrator:
//!
//! * It deploys Paso accounts. The address of an account depends only on this
//!   contract and on the owner's Ethereum address, so anyone can work it out,
//!   and pay into it, before the account exists.
//! * It sends USDC from Stellar to another chain over Circle's CCTP in one
//!   call, so that leaving takes a single signature.

#![no_std]

#[cfg(test)]
mod audit;
#[cfg(test)]
mod test;

use soroban_sdk::{
    auth::ContractExecutable, contract, contractclient, contracterror, contractevent, contractimpl,
    contracttype, panic_with_error, symbol_short, token::TokenClient, unwrap::UnwrapOptimized,
    Address, BytesN, Env, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum HubError {
    /// The amount must be positive and the fee limit must not be negative.
    BadAmount = 1,
    /// Amounts must be whole millionths of a USDC: no seventh decimal.
    Dust = 2,
}

/// The part of Circle's TokenMessengerMinter that `exit` uses.
#[contractclient(name = "TokenMessengerClient")]
pub trait TokenMessenger {
    /// Burns `amount` of `burn_token` held by `caller`, who must have
    /// approved this contract for it, and sends the message that mints the
    /// same value to `mint_recipient` on `destination_domain`.
    #[allow(clippy::too_many_arguments)]
    fn deposit_for_burn(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    );
}

/// USDC left `from` for `recipient` on the CCTP domain `destination_domain`.
#[contractevent]
pub struct Exit {
    #[topic]
    pub from: Address,
    pub amount: i128,
    pub destination_domain: u32,
    pub recipient: BytesN<32>,
}

#[contracttype]
struct Config {
    account_wasm: BytesN<32>,
    usdc: Address,
    token_messenger: Address,
}

const CONFIG: Symbol = symbol_short!("config");

/// Stellar USDC has seven decimals and CCTP carries six, so only multiples of
/// ten of the smallest Stellar unit can cross.
const STELLAR_UNITS_PER_CCTP_UNIT: i64 = 10;

#[contract]
pub struct PasoHub;

#[contractimpl]
impl PasoHub {
    /// `account_wasm` is the code every account runs, `usdc` the USDC token
    /// contract and `token_messenger` Circle's TokenMessengerMinter.
    pub fn __constructor(
        env: Env,
        account_wasm: BytesN<32>,
        usdc: Address,
        token_messenger: Address,
    ) {
        env.storage().instance().set(
            &CONFIG,
            &Config {
                account_wasm,
                usdc,
                token_messenger,
            },
        );
    }

    /// The Stellar account of an Ethereum address, whether or not it has
    /// been deployed yet.
    pub fn address_of(env: Env, owner: BytesN<20>) -> Address {
        env.deployer()
            .with_current_contract(salt(&env, &owner))
            .deployed_address()
    }

    /// Deploys the account of `owner` and returns its address. Anyone may
    /// call this, and calling it again changes nothing.
    pub fn deploy(env: Env, owner: BytesN<20>) -> Address {
        let deployer = env.deployer().with_current_contract(salt(&env, &owner));
        let address = deployer.deployed_address();
        if !address.exists() {
            let executable = ContractExecutable::Wasm(config(&env).account_wasm);
            deployer.deploy_contract(executable, (owner,));
        }
        address
    }

    /// Sends `amount` of `from`'s USDC to `recipient` on the CCTP domain
    /// `destination_domain`. Anyone may complete the transfer on the other
    /// side. `amount` and `max_fee` are in Stellar units of 0.0000001 USDC.
    pub fn exit(
        env: Env,
        from: Address,
        amount: i128,
        destination_domain: u32,
        recipient: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    ) {
        from.require_auth();

        // No USDC balance exceeds an i64, so nothing larger can be moved.
        let (Ok(units), Ok(fee_units)) = (i64::try_from(amount), i64::try_from(max_fee)) else {
            panic_with_error!(&env, HubError::BadAmount);
        };
        if units <= 0 || fee_units < 0 {
            panic_with_error!(&env, HubError::BadAmount);
        }
        // Circle burns only the part of an amount that fits six decimals and
        // leaves the rest with its caller, which here is this contract.
        if units % STELLAR_UNITS_PER_CCTP_UNIT != 0 || fee_units % STELLAR_UNITS_PER_CCTP_UNIT != 0
        {
            panic_with_error!(&env, HubError::Dust);
        }

        let Config {
            usdc,
            token_messenger,
            ..
        } = config(&env);
        let hub = env.current_contract_address();

        let token = TokenClient::new(&env, &usdc);
        token.transfer(&from, &hub, &amount);
        token.approve(&hub, &token_messenger, &amount, &env.ledger().sequence());

        TokenMessengerClient::new(&env, &token_messenger).deposit_for_burn(
            &hub,
            &amount,
            &destination_domain,
            &recipient,
            &usdc,
            &BytesN::from_array(&env, &[0; 32]),
            &max_fee,
            &min_finality_threshold,
        );

        Exit {
            from,
            amount,
            destination_domain,
            recipient,
        }
        .publish(&env);
    }
}

fn config(env: &Env) -> Config {
    env.storage().instance().get(&CONFIG).unwrap_optimized()
}

/// Twelve zero bytes, then the owner's address.
fn salt(env: &Env, owner: &BytesN<20>) -> BytesN<32> {
    let mut salt = [0u8; 32];
    salt[12..].copy_from_slice(&owner.to_array());
    BytesN::from_array(env, &salt)
}
