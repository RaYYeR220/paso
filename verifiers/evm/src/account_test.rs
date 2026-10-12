//! The verifier behind a real OpenZeppelin smart account.
//!
//! An account lists `External(verifier, <Ethereum address>)` as a signer and
//! spends tokens. Every transfer goes through the host's own authorisation
//! path: a `SorobanAuthorizationEntry` is set, the token calls
//! `require_auth`, the host calls the account's `__check_auth`, and the
//! account calls the verifier. The verifier is the wasm from
//! `stellar contract build`.
//!
//! Each scenario runs against two builds of the account:
//!
//! - the account wasm that `stellar/smart-account-kit` publishes on testnet
//!   and mainnet, built from OpenZeppelin/stellar-contracts at `1e513890`;
//! - OpenZeppelin's example account compiled here from the `stellar-accounts`
//!   0.7.2 crate.

extern crate std;

use std::vec::Vec as StdVec;

use ed25519_dalek::Signer as _;
use k256::ecdsa::SigningKey;
use sha2::{Digest as _, Sha256};
use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    map,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{
        self, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits,
        ScAddress, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
        SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, WriteXdr,
    },
    Address, Bytes, BytesN, Env, IntoVal, InvokeError, Map, String, Symbol, TryFromVal, Val, Vec,
};
use stellar_accounts::{
    policies::simple_threshold::SimpleThresholdAccountParams,
    smart_account::{
        self, AuthPayload, ContextRule, ContextRuleType, Signer, SmartAccount, SmartAccountError,
    },
};

use crate::test::{eth_address, reference_digest, sign, unhex, vectors, VERIFIER_WASM};

/// Wasm published on testnet and mainnet by `stellar/smart-account-kit`
/// (`docs/deployments-protocol-27-2026-07-09.md`), fetched from testnet by
/// hash. `fixtures_are_the_published_builds` checks the hashes.
const OZ_ACCOUNT_WASM: &[u8] =
    include_bytes!("../fixtures/openzeppelin/multisig_account_example.wasm");
const OZ_ACCOUNT_WASM_HASH: &str =
    "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a";
const OZ_THRESHOLD_POLICY_WASM: &[u8] =
    include_bytes!("../fixtures/openzeppelin/multisig_threshold_policy_example.wasm");
const OZ_THRESHOLD_POLICY_WASM_HASH: &str =
    "cb6c0bd9cd06abba05f924ff4157b41aa1dd3891803c7c93b3b158e20986e592";
const OZ_ED25519_VERIFIER_WASM: &[u8] =
    include_bytes!("../fixtures/openzeppelin/multisig_ed25519_verifier_example.wasm");
const OZ_ED25519_VERIFIER_WASM_HASH: &str =
    "60e8798db610bdaf3370d39ebda56ee1dc2c15ce1c3a9e28b528bfa24a06b477";

/// sha256 of "Test SDF Network ; September 2015".
const NETWORK_ID: [u8; 32] = [
    0xce, 0xe0, 0x30, 0x2d, 0x59, 0x84, 0x4d, 0x32, 0xbd, 0xca, 0x91, 0x5c, 0x82, 0x03, 0xdd, 0x44,
    0xb3, 0x3f, 0xbb, 0x7e, 0xdc, 0x19, 0x05, 0x1e, 0xa3, 0x7a, 0xbe, 0xdf, 0x28, 0xec, 0xd4, 0x72,
];

/// The rule the account's constructor creates.
const DEFAULT_RULE: u32 = 0;

const BALANCE: i128 = 1_000;
const AMOUNT: i128 = 250;
const EXPIRATION_LEDGER: u32 = 1_000;

/// OpenZeppelin's example account (`examples/multisig-smart-account/account`
/// at v0.7.2) without its upgrade entry point.
#[contract]
struct CrateAccount;

#[contractimpl]
impl CrateAccount {
    pub fn __constructor(e: &Env, signers: Vec<Signer>, policies: Map<Address, Val>) {
        smart_account::add_context_rule(
            e,
            &ContextRuleType::Default,
            &String::from_str(e, "multisig"),
            None,
            &signers,
            &policies,
        );
    }
}

#[contractimpl]
impl CustomAccountInterface for CrateAccount {
    type Error = SmartAccountError;
    type Signature = AuthPayload;

    #[allow(non_snake_case)]
    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        smart_account::do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
    }
}

#[contractimpl(contracttrait)]
impl SmartAccount for CrateAccount {}

#[derive(Copy, Clone, Debug)]
enum AccountBuild {
    /// The wasm published on testnet and mainnet.
    PublishedWasm,
    /// Compiled here from `stellar-accounts` 0.7.2.
    Crate,
}

const BUILDS: [AccountBuild; 2] = [AccountBuild::PublishedWasm, AccountBuild::Crate];

struct World {
    env: Env,
    verifier: Address,
    token: Address,
    recipient: Address,
}

fn world() -> World {
    let env = Env::default();
    env.ledger().set_network_id(NETWORK_ID);
    let verifier = env.register(VERIFIER_WASM, ());
    let issuer = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(issuer).address();
    let recipient = Address::generate(&env);
    World {
        env,
        verifier,
        token,
        recipient,
    }
}

impl World {
    /// The signer entry for an Ethereum address checked by the verifier.
    fn ethereum_signer(&self, key: &SigningKey) -> Signer {
        Signer::External(
            self.verifier.clone(),
            Bytes::from_array(&self.env, &eth_address(key)),
        )
    }

    /// Deploys an account whose default rule holds `signers` and `policies`,
    /// and gives it [`BALANCE`] tokens.
    fn account(
        &self,
        build: AccountBuild,
        signers: Vec<Signer>,
        policies: Map<Address, Val>,
    ) -> Address {
        let account = match build {
            AccountBuild::PublishedWasm => self.env.register(OZ_ACCOUNT_WASM, (signers, policies)),
            AccountBuild::Crate => self.env.register(CrateAccount, (signers, policies)),
        };
        self.env.mock_all_auths();
        StellarAssetClient::new(&self.env, &self.token).mint(&account, &BALANCE);
        // Nothing is authorised from here on unless a test sets an entry.
        self.env.set_auths(&[]);
        account
    }

    fn rule(&self, account: &Address) -> ContextRule {
        self.env.invoke_contract(
            account,
            &Symbol::new(&self.env, "get_context_rule"),
            vec![&self.env, DEFAULT_RULE.into_val(&self.env)],
        )
    }

    fn balance(&self, of: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(of)
    }

    /// `token.transfer(account, recipient, amount)` as the tree an entry
    /// authorises.
    fn transfer_invocation(&self, account: &Address, amount: i128) -> SorobanAuthorizedInvocation {
        let amount: Val = amount.into_val(&self.env);
        let args: StdVec<ScVal> = std::vec![
            ScVal::Address(ScAddress::from(account)),
            ScVal::Address(ScAddress::from(&self.recipient)),
            ScVal::try_from_val(&self.env, &amount).unwrap(),
        ];
        SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::from(&self.token),
                function_name: "transfer".try_into().unwrap(),
                args: args.try_into().unwrap(),
            }),
            sub_invocations: xdr::VecM::default(),
        }
    }

    /// The same call as the single context `__check_auth` receives for it.
    fn transfer_context(&self, account: &Address, amount: i128) -> Vec<Context> {
        vec![
            &self.env,
            Context::Contract(ContractContext {
                contract: self.token.clone(),
                fn_name: Symbol::new(&self.env, "transfer"),
                args: vec![
                    &self.env,
                    account.into_val(&self.env),
                    self.recipient.into_val(&self.env),
                    amount.into_val(&self.env),
                ],
            }),
        ]
    }

    /// The account's signature value: who signed, with what, under which rule.
    fn auth_payload(&self, signatures: &[(Signer, StdVec<u8>)]) -> AuthPayload {
        let mut signers = Map::new(&self.env);
        for (signer, signature) in signatures {
            signers.set(signer.clone(), Bytes::from_slice(&self.env, signature));
        }
        AuthPayload {
            signers,
            context_rule_ids: vec![&self.env, DEFAULT_RULE],
        }
    }

    /// Sets the one authorisation entry of the transaction and attempts the
    /// transfer. `signed_amount` is what the entry and the signatures cover;
    /// `sent_amount` is what the transaction then asks for.
    fn transfer(
        &self,
        account: &Address,
        nonce: i64,
        signed_amount: i128,
        sent_amount: i128,
        signatures: &[(Signer, StdVec<u8>)],
    ) -> bool {
        let signature: Val = self.auth_payload(signatures).into_val(&self.env);
        self.env.set_auths(&[SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(account),
                nonce,
                signature_expiration_ledger: EXPIRATION_LEDGER,
                signature: ScVal::try_from_val(&self.env, &signature).unwrap(),
            }),
            root_invocation: self.transfer_invocation(account, signed_amount),
        }]);

        TokenClient::new(&self.env, &self.token)
            .try_transfer(account, &self.recipient, &sent_amount)
            .is_ok()
    }

    /// What the account's `__check_auth` answers for the same transfer.
    fn check_auth(
        &self,
        account: &Address,
        nonce: i64,
        amount: i128,
        signatures: &[(Signer, StdVec<u8>)],
    ) -> Result<(), Result<SmartAccountError, InvokeError>> {
        self.env
            .try_invoke_contract_check_auth::<SmartAccountError>(
                account,
                &BytesN::from_array(
                    &self.env,
                    &self.soroban_payload(nonce, &self.transfer_invocation(account, amount)),
                ),
                self.auth_payload(signatures).into_val(&self.env),
                &self.transfer_context(account, amount),
            )
    }

    /// The payload the host derives from an entry and passes to
    /// `__check_auth`.
    fn soroban_payload(&self, nonce: i64, invocation: &SorobanAuthorizedInvocation) -> [u8; 32] {
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(NETWORK_ID),
            nonce,
            signature_expiration_ledger: EXPIRATION_LEDGER,
            invocation: invocation.clone(),
        });
        Sha256::digest(preimage.to_xdr(Limits::none()).unwrap()).into()
    }

    /// The 32 bytes the account hands to its verifiers for a transfer.
    fn verifier_payload(&self, account: &Address, nonce: i64, amount: i128) -> [u8; 32] {
        auth_digest(
            &self.soroban_payload(nonce, &self.transfer_invocation(account, amount)),
            &[DEFAULT_RULE],
        )
    }

    /// The Ethereum signature an account expects for a transfer.
    fn ethereum_signature(
        &self,
        key: &SigningKey,
        account: &Address,
        nonce: i64,
        amount: i128,
    ) -> StdVec<u8> {
        let payload = self.verifier_payload(account, nonce, amount);
        sign(key, &reference_digest(&NETWORK_ID, &payload)).to_vec()
    }
}

/// What a `stellar-accounts` 0.7.2 account asks its signers to sign: sha256
/// of the Soroban payload followed by the XDR of the selected rule ids.
fn auth_digest(soroban_payload: &[u8; 32], context_rule_ids: &[u32]) -> [u8; 32] {
    let ids: StdVec<ScVal> = context_rule_ids.iter().map(|id| ScVal::U32(*id)).collect();
    let ids = ScVal::Vec(Some(xdr::ScVec(ids.try_into().unwrap())));

    let mut preimage = soroban_payload.to_vec();
    preimage.extend_from_slice(&ids.to_xdr(Limits::none()).unwrap());
    Sha256::digest(preimage).into()
}

fn ethereum_key(seed: u8) -> SigningKey {
    SigningKey::from_slice(&[seed; 32]).unwrap()
}

#[test]
fn fixtures_are_the_published_builds() {
    for (wasm, hash) in [
        (OZ_ACCOUNT_WASM, OZ_ACCOUNT_WASM_HASH),
        (OZ_THRESHOLD_POLICY_WASM, OZ_THRESHOLD_POLICY_WASM_HASH),
        (OZ_ED25519_VERIFIER_WASM, OZ_ED25519_VERIFIER_WASM_HASH),
    ] {
        assert_eq!(hex::encode(Sha256::digest(wasm)), hash);
    }
}

#[test]
fn auth_digest_matches_the_vectors() {
    let mut seen = 0;
    for v in vectors() {
        let Some(oz) = &v.open_zeppelin else { continue };
        assert_eq!(
            auth_digest(&unhex(&oz.signature_payload), &oz.context_rule_ids),
            unhex::<32>(&v.payload),
            "{}",
            v.name
        );
        seen += 1;
    }
    assert_eq!(seen, 2);
}

#[test]
fn ethereum_signer_authorises_a_transfer() {
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let signer = w.ethereum_signer(&key);
        let account = w.account(build, vec![&w.env, signer.clone()], map![&w.env]);

        let rule = w.rule(&account);
        assert_eq!(rule.context_type, ContextRuleType::Default);
        assert_eq!(rule.signers, vec![&w.env, signer.clone()]);
        assert!(rule.policies.is_empty());

        let signature = w.ethereum_signature(&key, &account, 7, AMOUNT);
        assert!(
            w.transfer(&account, 7, AMOUNT, AMOUNT, &[(signer, signature)]),
            "{build:?}"
        );
        assert_eq!(w.balance(&account), BALANCE - AMOUNT);
        assert_eq!(w.balance(&w.recipient), AMOUNT);
    }
}

#[test]
fn transfer_without_an_entry_is_refused() {
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let account = w.account(build, vec![&w.env, w.ethereum_signer(&key)], map![&w.env]);

        w.env.set_auths(&[]);
        assert!(TokenClient::new(&w.env, &w.token)
            .try_transfer(&account, &w.recipient, &AMOUNT)
            .is_err());
        assert_eq!(w.balance(&account), BALANCE);
    }
}

#[test]
fn wrong_key_is_refused() {
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let stranger = ethereum_key(0x42);
        let signer = w.ethereum_signer(&key);
        let account = w.account(build, vec![&w.env, signer.clone()], map![&w.env]);

        // Signed by another key, presented as the account's signer.
        let forged = w.ethereum_signature(&stranger, &account, 7, AMOUNT);
        let signatures = [(signer.clone(), forged.clone())];
        assert_eq!(
            w.check_auth(&account, 7, AMOUNT, &signatures),
            Err(Ok(SmartAccountError::ExternalVerificationFailed)),
            "{build:?}"
        );
        assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT, &signatures));
        assert_eq!(w.balance(&account), BALANCE);
        assert_eq!(w.balance(&w.recipient), 0);

        // The same signature under the stranger's own address: a valid
        // signature, by a signer the account does not have.
        let signatures = [(w.ethereum_signer(&stranger), forged)];
        assert_eq!(
            w.check_auth(&account, 7, AMOUNT, &signatures),
            Err(Ok(SmartAccountError::UnvalidatedContext)),
            "{build:?}"
        );
        assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT, &signatures));
        assert_eq!(w.balance(&account), BALANCE);

        // The harness itself is sound: the right key passes on the same account.
        let signature = w.ethereum_signature(&key, &account, 7, AMOUNT);
        assert!(w.transfer(&account, 7, AMOUNT, AMOUNT, &[(signer, signature)]));
    }
}

#[test]
fn signature_does_not_carry_over_to_another_call() {
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let signer = w.ethereum_signer(&key);
        let account = w.account(build, vec![&w.env, signer.clone()], map![&w.env]);
        let signature = w.ethereum_signature(&key, &account, 7, AMOUNT);
        let signatures = [(signer, signature)];

        // The entry covers one amount and the transaction asks for another.
        assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT + 1, &signatures));
        // The entry is rewritten to the other amount, the signature kept.
        assert!(!w.transfer(&account, 7, AMOUNT + 1, AMOUNT + 1, &signatures));
        assert_eq!(
            w.check_auth(&account, 7, AMOUNT + 1, &signatures),
            Err(Ok(SmartAccountError::ExternalVerificationFailed)),
            "{build:?}"
        );
        // Another nonce.
        assert!(!w.transfer(&account, 8, AMOUNT, AMOUNT, &signatures));
        assert_eq!(w.balance(&account), BALANCE);

        // Used as signed, it passes once and never again.
        assert!(w.transfer(&account, 7, AMOUNT, AMOUNT, &signatures));
        assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT, &signatures));
        assert_eq!(w.balance(&account), BALANCE - AMOUNT);
    }
}

#[test]
fn signature_over_the_soroban_payload_itself_is_refused() {
    // The account signs over its own digest, which adds the rule ids to the
    // Soroban payload. A signature over the payload alone does not pass.
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let signer = w.ethereum_signer(&key);
        let account = w.account(build, vec![&w.env, signer.clone()], map![&w.env]);

        let payload = w.soroban_payload(7, &w.transfer_invocation(&account, AMOUNT));
        let signature = sign(&key, &reference_digest(&NETWORK_ID, &payload)).to_vec();
        assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT, &[(signer, signature)]));
        assert_eq!(w.balance(&account), BALANCE);
    }
}

#[test]
fn malformed_signature_is_refused() {
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let signer = w.ethereum_signer(&key);
        let account = w.account(build, vec![&w.env, signer.clone()], map![&w.env]);
        let good = w.ethereum_signature(&key, &account, 7, AMOUNT);

        let mut bad_recovery = good.clone();
        bad_recovery[64] = 2;
        let mut zero_s = good.clone();
        zero_s[32..64].fill(0);
        for bad in [bad_recovery, zero_s, good[..64].to_vec(), StdVec::new()] {
            assert!(
                !w.transfer(&account, 7, AMOUNT, AMOUNT, &[(signer.clone(), bad)]),
                "{build:?}"
            );
        }
        assert_eq!(w.balance(&account), BALANCE);

        assert!(w.transfer(&account, 7, AMOUNT, AMOUNT, &[(signer, good)]));
    }
}

/// An account whose default rule holds an Ed25519 signer and an Ethereum
/// signer, with OpenZeppelin's threshold policy asking for one of them.
struct OneOfTwo {
    w: World,
    account: Address,
    ed25519_key: ed25519_dalek::SigningKey,
    ed25519_signer: Signer,
    ethereum_key: SigningKey,
    ethereum_signer: Signer,
}

fn one_of_two(build: AccountBuild) -> OneOfTwo {
    let w = world();
    let ed25519_verifier = w.env.register(OZ_ED25519_VERIFIER_WASM, ());
    let threshold_policy = w.env.register(OZ_THRESHOLD_POLICY_WASM, ());

    let ed25519_key = ed25519_dalek::SigningKey::from_bytes(&[0x23; 32]);
    let ed25519_signer = Signer::External(
        ed25519_verifier,
        Bytes::from_array(&w.env, ed25519_key.verifying_key().as_bytes()),
    );
    let ethereum_key = ethereum_key(0x17);
    let ethereum_signer = w.ethereum_signer(&ethereum_key);

    let policies: Map<Address, Val> = map![
        &w.env,
        (
            threshold_policy.clone(),
            SimpleThresholdAccountParams { threshold: 1 }.into_val(&w.env)
        )
    ];
    let account = w.account(
        build,
        vec![&w.env, ed25519_signer.clone(), ethereum_signer.clone()],
        policies,
    );

    let rule = w.rule(&account);
    assert_eq!(
        rule.signers,
        vec![&w.env, ed25519_signer.clone(), ethereum_signer.clone()]
    );
    assert_eq!(rule.policies, vec![&w.env, threshold_policy]);

    OneOfTwo {
        w,
        account,
        ed25519_key,
        ed25519_signer,
        ethereum_key,
        ethereum_signer,
    }
}

#[test]
fn one_of_two_ethereum_signer_alone() {
    for build in BUILDS {
        let t = one_of_two(build);
        let signature =
            t.w.ethereum_signature(&t.ethereum_key, &t.account, 7, AMOUNT);
        assert!(
            t.w.transfer(
                &t.account,
                7,
                AMOUNT,
                AMOUNT,
                &[(t.ethereum_signer.clone(), signature)]
            ),
            "{build:?}"
        );
        assert_eq!(t.w.balance(&t.account), BALANCE - AMOUNT);
        assert_eq!(t.w.balance(&t.w.recipient), AMOUNT);
    }
}

#[test]
fn one_of_two_ed25519_signer_alone() {
    // The other half of the same rule, to show it is one of two and not an
    // account that the Ethereum key simply owns.
    for build in BUILDS {
        let t = one_of_two(build);
        let payload = t.w.verifier_payload(&t.account, 7, AMOUNT);
        let signature = t.ed25519_key.sign(&payload).to_bytes().to_vec();
        assert!(
            t.w.transfer(
                &t.account,
                7,
                AMOUNT,
                AMOUNT,
                &[(t.ed25519_signer.clone(), signature)]
            ),
            "{build:?}"
        );
        assert_eq!(t.w.balance(&t.account), BALANCE - AMOUNT);
    }
}

#[test]
fn one_of_two_both_signers() {
    for build in BUILDS {
        let t = one_of_two(build);
        let payload = t.w.verifier_payload(&t.account, 7, AMOUNT);
        let signatures = [
            (
                t.ed25519_signer.clone(),
                t.ed25519_key.sign(&payload).to_bytes().to_vec(),
            ),
            (
                t.ethereum_signer.clone(),
                t.w.ethereum_signature(&t.ethereum_key, &t.account, 7, AMOUNT),
            ),
        ];
        assert!(
            t.w.transfer(&t.account, 7, AMOUNT, AMOUNT, &signatures),
            "{build:?}"
        );
        assert_eq!(t.w.balance(&t.account), BALANCE - AMOUNT);
    }
}

#[test]
fn one_of_two_refuses_a_wrong_ethereum_key_and_no_signature() {
    for build in BUILDS {
        let t = one_of_two(build);
        let forged =
            t.w.ethereum_signature(&ethereum_key(0x42), &t.account, 7, AMOUNT);
        let signatures = [(t.ethereum_signer.clone(), forged)];
        assert_eq!(
            t.w.check_auth(&t.account, 7, AMOUNT, &signatures),
            Err(Ok(SmartAccountError::ExternalVerificationFailed)),
            "{build:?}"
        );
        assert!(!t.w.transfer(&t.account, 7, AMOUNT, AMOUNT, &signatures));

        // No signer at all: the threshold of one is not met.
        assert!(!t.w.transfer(&t.account, 7, AMOUNT, AMOUNT, &[]));
        assert_eq!(t.w.balance(&t.account), BALANCE);
        assert_eq!(t.w.balance(&t.w.recipient), 0);
    }
}

impl World {
    /// `add_signer` on the account's default rule, with the account's own
    /// authorisation mocked: what is under test is the account's check of
    /// the new key, which it makes through the verifier.
    fn add_signer(
        &self,
        account: &Address,
        signer: &Signer,
    ) -> Result<u32, Result<SmartAccountError, InvokeError>> {
        self.env.mock_all_auths();
        let added = self
            .env
            .try_invoke_contract::<u32, SmartAccountError>(
                account,
                &Symbol::new(&self.env, "add_signer"),
                vec![
                    &self.env,
                    DEFAULT_RULE.into_val(&self.env),
                    signer.into_val(&self.env),
                ],
            )
            .map(|id| id.unwrap());
        self.env.set_auths(&[]);
        added
    }
}

#[test]
fn account_refuses_the_same_address_twice() {
    // The account asks the verifier for the canonical form of each key and
    // refuses a rule that would hold one key twice.
    for build in BUILDS {
        let w = world();
        let signer = w.ethereum_signer(&ethereum_key(0x17));
        let account = w.account(build, vec![&w.env, signer.clone()], map![&w.env]);

        assert_eq!(
            w.add_signer(&account, &signer),
            Err(Ok(SmartAccountError::DuplicateSigner)),
            "{build:?}"
        );
        assert_eq!(w.rule(&account).signers, vec![&w.env, signer.clone()]);

        let second = w.ethereum_signer(&ethereum_key(0x42));
        assert_eq!(w.add_signer(&account, &second), Ok(1), "{build:?}");
        assert_eq!(w.rule(&account).signers, vec![&w.env, signer, second]);
    }
}

#[test]
fn account_refuses_key_data_that_is_not_an_address() {
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let signer = w.ethereum_signer(&key);
        let account = w.account(build, vec![&w.env, signer.clone()], map![&w.env]);

        // The address of another key, left-padded to 32 bytes the way EVM
        // words carry it, and cut short by a byte.
        let address = eth_address(&ethereum_key(0x42));
        let mut padded = [0u8; 32];
        padded[12..].copy_from_slice(&address);
        for bad in [&padded[..], &address[..19]] {
            let signer = Signer::External(w.verifier.clone(), Bytes::from_slice(&w.env, bad));
            assert!(w.add_signer(&account, &signer).is_err(), "{build:?}");
        }
        assert_eq!(w.rule(&account).signers, vec![&w.env, signer]);

        let well_formed = Signer::External(w.verifier.clone(), Bytes::from_array(&w.env, &address));
        assert_eq!(w.add_signer(&account, &well_formed), Ok(1), "{build:?}");
    }
}

/// A contract whose one call needs two addresses to authorise it.
#[contract]
struct Gate;

#[contractimpl]
impl Gate {
    pub fn open(_env: Env, first: Address, second: Address) {
        first.require_auth();
        second.require_auth();
    }
}

#[test]
fn legacy_credentials_do_not_tie_a_signature_to_one_account() {
    // A limit, not a feature. The verifier cannot tell accounts apart, and
    // with the legacy credential encoding neither does the payload: it holds
    // the network, the nonce, the expiry and the call. Two accounts that
    // list the same Ethereum address, asked to authorise the same call under
    // the same nonce, accept the same signature. The address-bound encoding
    // (CAP-71) puts the account in the payload; the host these tests run on
    // predates it.
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let signer = w.ethereum_signer(&key);
        let first = w.account(build, vec![&w.env, signer.clone()], map![&w.env]);
        let second = w.account(build, vec![&w.env, signer.clone()], map![&w.env]);
        let gate = w.env.register(Gate, ());

        let args: StdVec<ScVal> = std::vec![
            ScVal::Address(ScAddress::from(&first)),
            ScVal::Address(ScAddress::from(&second)),
        ];
        let invocation = SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::from(&gate),
                function_name: "open".try_into().unwrap(),
                args: args.try_into().unwrap(),
            }),
            sub_invocations: xdr::VecM::default(),
        };

        // One signature, made once.
        let payload = auth_digest(&w.soroban_payload(7, &invocation), &[DEFAULT_RULE]);
        let signature = sign(&key, &reference_digest(&NETWORK_ID, &payload)).to_vec();
        let value: Val = w
            .auth_payload(&[(signer.clone(), signature)])
            .into_val(&w.env);
        let entry = |account: &Address, nonce: i64| SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(account),
                nonce,
                signature_expiration_ledger: EXPIRATION_LEDGER,
                signature: ScVal::try_from_val(&w.env, &value).unwrap(),
            }),
            root_invocation: invocation.clone(),
        };
        let open = || {
            w.env
                .try_invoke_contract::<(), soroban_sdk::Error>(
                    &gate,
                    &Symbol::new(&w.env, "open"),
                    vec![&w.env, first.into_val(&w.env), second.into_val(&w.env)],
                )
                .is_ok()
        };

        // Under another nonce the second account's payload differs and the
        // signature does not pass.
        w.env.set_auths(&[entry(&first, 7), entry(&second, 8)]);
        assert!(!open(), "{build:?}");

        // Under the same nonce it passes for both.
        w.env.set_auths(&[entry(&first, 7), entry(&second, 7)]);
        assert!(open(), "{build:?}");
    }
}
