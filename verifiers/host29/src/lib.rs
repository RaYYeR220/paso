//! The verifier wasm behind the published OpenZeppelin account, on the host
//! of `soroban-sdk` 29 (protocol 29).
//!
//! That host accepts both encodings of address credentials: the legacy one,
//! whose payload names no account, and the address-bound one, whose payload
//! does. The tests in `../evm` run on an older host that has the legacy
//! encoding only, so the checks that concern the encoding are here.
//!
//! This crate holds tests and nothing else.

#[cfg(test)]
mod test;
