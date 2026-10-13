//! The verifier behind a real OpenZeppelin smart account.
//!
//! An account lists `External(verifier, <Ethereum address ‖ its own id>)` as
//! a signer and acts. Every call goes through the host's own authorisation
//! path: a `SorobanAuthorizationEntry` is set, the called contract calls
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
//!
//! The host here is the one of `soroban-sdk` 26, which knows the legacy
//! credential encoding only. `../../host29` runs the address-bound encoding.

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

use crate::{
    test::{
        contract_strkey, eth_address, fixture, key_data, reference_digest, sign, unhex, vectors,
        VERIFIER_WASM,
    },
    EvmVerifierError,
};

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

/// Who signed and with what: the entries of an account's signature value.
type Signatures = [(Signer, StdVec<u8>)];

/// What the account's `__check_auth` answers.
type Checked = Result<(), Result<SmartAccountError, InvokeError>>;

/// Contract id of a contract address.
fn id_of(address: &Address) -> [u8; 32] {
    match ScAddress::from(address) {
        ScAddress::Contract(xdr::ContractId(xdr::Hash(id))) => id,
        other => panic!("{other:?} is not a contract"),
    }
}

fn invocation(
    contract: &Address,
    function: &str,
    args: StdVec<ScVal>,
) -> SorobanAuthorizedInvocation {
    SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: ScAddress::from(contract),
            function_name: function.try_into().unwrap(),
            args: args.try_into().unwrap(),
        }),
        sub_invocations: xdr::VecM::default(),
    }
}

/// The payload the host derives from an entry with legacy credentials and
/// passes to `__check_auth`. It names no account.
fn soroban_payload(nonce: i64, invocation: &SorobanAuthorizedInvocation) -> [u8; 32] {
    let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
        network_id: xdr::Hash(NETWORK_ID),
        nonce,
        signature_expiration_ledger: EXPIRATION_LEDGER,
        invocation: invocation.clone(),
    });
    Sha256::digest(preimage.to_xdr(Limits::none()).unwrap()).into()
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

/// The 32 bytes an account hands to its verifiers for one call under the
/// default rule.
fn verifier_payload(nonce: i64, invocation: &SorobanAuthorizedInvocation) -> [u8; 32] {
    auth_digest(&soroban_payload(nonce, invocation), &[DEFAULT_RULE])
}

/// The signature of `key` over `payload`, made for `account`.
fn ethereum_signature(key: &SigningKey, account: &Address, payload: &[u8; 32]) -> StdVec<u8> {
    let account = contract_strkey(&id_of(account));
    sign(key, &reference_digest(&NETWORK_ID, &account, payload)).to_vec()
}

fn ethereum_key(seed: u8) -> SigningKey {
    SigningKey::from_slice(&[seed; 32]).unwrap()
}

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
    /// The signer entry of an Ethereum key registered for `account`.
    fn ethereum_signer(&self, key: &SigningKey, account: &Address) -> Signer {
        Signer::External(
            self.verifier.clone(),
            Bytes::from_array(&self.env, &key_data(&eth_address(key), &id_of(account))),
        )
    }

    /// Deploys an account at `account` whose default rule holds `signers`
    /// and `policies`, and gives it [`BALANCE`] tokens. The address is chosen
    /// first because the signers have to name it.
    fn deploy(
        &self,
        build: AccountBuild,
        account: &Address,
        signers: Vec<Signer>,
        policies: Map<Address, Val>,
    ) {
        match build {
            AccountBuild::PublishedWasm => {
                self.env
                    .register_at(account, OZ_ACCOUNT_WASM, (signers, policies))
            }
            AccountBuild::Crate => self
                .env
                .register_at(account, CrateAccount, (signers, policies)),
        };
        self.env.mock_all_auths();
        StellarAssetClient::new(&self.env, &self.token).mint(account, &BALANCE);
        // Nothing is authorised from here on unless a test sets an entry.
        self.env.set_auths(&[]);
    }

    /// An account whose only signer is the Ethereum key.
    fn account_of(&self, build: AccountBuild, key: &SigningKey) -> (Address, Signer) {
        let account = Address::generate(&self.env);
        let signer = self.ethereum_signer(key, &account);
        self.deploy(
            build,
            &account,
            vec![&self.env, signer.clone()],
            map![&self.env],
        );
        (account, signer)
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

    fn sc_val(&self, value: impl IntoVal<Env, Val>) -> ScVal {
        let value: Val = value.into_val(&self.env);
        ScVal::try_from_val(&self.env, &value).unwrap()
    }

    /// The account's signature value: who signed, with what, under which rule.
    fn auth_payload(&self, signatures: &Signatures) -> AuthPayload {
        let mut signers = Map::new(&self.env);
        for (signer, signature) in signatures {
            signers.set(signer.clone(), Bytes::from_slice(&self.env, signature));
        }
        AuthPayload {
            signers,
            context_rule_ids: vec![&self.env, DEFAULT_RULE],
        }
    }

    /// An authorisation entry of `account` for `invocation`, with legacy
    /// credentials.
    fn entry(
        &self,
        account: &Address,
        nonce: i64,
        invocation: &SorobanAuthorizedInvocation,
        signatures: &Signatures,
    ) -> SorobanAuthorizationEntry {
        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(account),
                nonce,
                signature_expiration_ledger: EXPIRATION_LEDGER,
                signature: self.sc_val(self.auth_payload(signatures)),
            }),
            root_invocation: invocation.clone(),
        }
    }

    /// `token.transfer(account, recipient, amount)` as the tree an entry
    /// authorises.
    fn transfer_invocation(&self, account: &Address, amount: i128) -> SorobanAuthorizedInvocation {
        invocation(
            &self.token,
            "transfer",
            std::vec![
                self.sc_val(account),
                self.sc_val(&self.recipient),
                self.sc_val(amount),
            ],
        )
    }

    /// The 32 bytes the account hands to its verifiers for a transfer.
    fn transfer_payload(&self, account: &Address, nonce: i64, amount: i128) -> [u8; 32] {
        verifier_payload(nonce, &self.transfer_invocation(account, amount))
    }

    /// The Ethereum signature an account expects for a transfer.
    fn transfer_signature(
        &self,
        key: &SigningKey,
        account: &Address,
        nonce: i64,
        amount: i128,
    ) -> StdVec<u8> {
        ethereum_signature(key, account, &self.transfer_payload(account, nonce, amount))
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
        signatures: &Signatures,
    ) -> bool {
        self.env.set_auths(&[self.entry(
            account,
            nonce,
            &self.transfer_invocation(account, signed_amount),
            signatures,
        )]);
        TokenClient::new(&self.env, &self.token)
            .try_transfer(account, &self.recipient, &sent_amount)
            .is_ok()
    }

    /// What the account's `__check_auth` answers for the same transfer.
    fn check_transfer(
        &self,
        account: &Address,
        nonce: i64,
        amount: i128,
        signatures: &Signatures,
    ) -> Checked {
        let context = Context::Contract(ContractContext {
            contract: self.token.clone(),
            fn_name: Symbol::new(&self.env, "transfer"),
            args: vec![
                &self.env,
                account.into_val(&self.env),
                self.recipient.into_val(&self.env),
                amount.into_val(&self.env),
            ],
        });
        self.env
            .try_invoke_contract_check_auth::<SmartAccountError>(
                account,
                &BytesN::from_array(
                    &self.env,
                    &soroban_payload(nonce, &self.transfer_invocation(account, amount)),
                ),
                self.auth_payload(signatures).into_val(&self.env),
                &vec![&self.env, context],
            )
    }

    /// `account.add_signer(default rule, signer)` as the tree an entry
    /// authorises: a call of the account on itself.
    fn add_signer_invocation(
        &self,
        account: &Address,
        signer: &Signer,
    ) -> SorobanAuthorizedInvocation {
        invocation(
            account,
            "add_signer",
            std::vec![ScVal::U32(DEFAULT_RULE), self.sc_val(signer)],
        )
    }

    /// Calls `add_signer` under whatever authorisation is set.
    fn call_add_signer(
        &self,
        account: &Address,
        signer: &Signer,
    ) -> Result<u32, Result<SmartAccountError, InvokeError>> {
        self.env
            .try_invoke_contract::<u32, SmartAccountError>(
                account,
                &Symbol::new(&self.env, "add_signer"),
                vec![
                    &self.env,
                    DEFAULT_RULE.into_val(&self.env),
                    signer.into_val(&self.env),
                ],
            )
            .map(|id| id.unwrap())
    }

    /// `add_signer` with the account's own authorisation mocked: what is
    /// under test is the account's check of the new key, which it makes
    /// through the verifier.
    fn add_signer_unchecked(
        &self,
        account: &Address,
        signer: &Signer,
    ) -> Result<u32, Result<SmartAccountError, InvokeError>> {
        self.env.mock_all_auths();
        let added = self.call_add_signer(account, signer);
        self.env.set_auths(&[]);
        added
    }
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
fn signature_value_matches_the_vectors() {
    // The vectors spell the value out as XDR, signers in key order. Here it
    // is built from the account library's own types, which the host orders.
    let env = Env::default();
    let payloads = fixture().auth_payloads;
    assert_eq!(payloads.len(), 2);
    for p in payloads {
        let verifier = Address::from_str(&env, &p.verifier);
        let account = Address::from_str(&env, &p.account);
        let mut signers = Map::new(&env);
        for s in &p.signers {
            signers.set(
                Signer::External(
                    verifier.clone(),
                    Bytes::from_array(&env, &key_data(&unhex(&s.address), &id_of(&account))),
                ),
                Bytes::from_array(&env, &unhex::<65>(&s.signature)),
            );
        }
        let value: Val = AuthPayload {
            signers,
            context_rule_ids: Vec::from_slice(&env, &p.context_rule_ids),
        }
        .into_val(&env);
        let value = ScVal::try_from_val(&env, &value).unwrap();
        assert_eq!(
            hex::encode(value.to_xdr(Limits::none()).unwrap()),
            p.xdr.trim_start_matches("0x"),
            "{}",
            p.name
        );
    }
}

#[test]
fn ethereum_signer_authorises_a_transfer() {
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let (account, signer) = w.account_of(build, &key);

        let rule = w.rule(&account);
        assert_eq!(rule.context_type, ContextRuleType::Default);
        assert_eq!(rule.signers, vec![&w.env, signer.clone()]);
        assert!(rule.policies.is_empty());

        let signature = w.transfer_signature(&key, &account, 7, AMOUNT);
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
        let (account, _) = w.account_of(build, &ethereum_key(0x17));

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
        let (account, signer) = w.account_of(build, &key);

        // Signed by another key, presented as the account's signer.
        let forged = w.transfer_signature(&stranger, &account, 7, AMOUNT);
        let signatures = [(signer.clone(), forged.clone())];
        assert_eq!(
            w.check_transfer(&account, 7, AMOUNT, &signatures),
            Err(Ok(SmartAccountError::ExternalVerificationFailed)),
            "{build:?}"
        );
        assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT, &signatures));
        assert_eq!(w.balance(&account), BALANCE);
        assert_eq!(w.balance(&w.recipient), 0);

        // The same signature under the stranger's own address: a valid
        // signature, by a signer the account does not have.
        let signatures = [(w.ethereum_signer(&stranger, &account), forged)];
        assert_eq!(
            w.check_transfer(&account, 7, AMOUNT, &signatures),
            Err(Ok(SmartAccountError::UnvalidatedContext)),
            "{build:?}"
        );
        assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT, &signatures));
        assert_eq!(w.balance(&account), BALANCE);

        // The harness itself is sound: the right key passes on the same account.
        let signature = w.transfer_signature(&key, &account, 7, AMOUNT);
        assert!(w.transfer(&account, 7, AMOUNT, AMOUNT, &[(signer, signature)]));
    }
}

#[test]
fn signature_does_not_carry_over_to_another_call() {
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let (account, signer) = w.account_of(build, &key);
        let signature = w.transfer_signature(&key, &account, 7, AMOUNT);
        let signatures = [(signer, signature)];

        // The entry covers one amount and the transaction asks for another.
        assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT + 1, &signatures));
        // The entry is rewritten to the other amount, the signature kept.
        assert!(!w.transfer(&account, 7, AMOUNT + 1, AMOUNT + 1, &signatures));
        assert_eq!(
            w.check_transfer(&account, 7, AMOUNT + 1, &signatures),
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
        let (account, signer) = w.account_of(build, &key);

        let payload = soroban_payload(7, &w.transfer_invocation(&account, AMOUNT));
        let signature = ethereum_signature(&key, &account, &payload);
        assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT, &[(signer, signature)]));
        assert_eq!(w.balance(&account), BALANCE);
    }
}

#[test]
fn malformed_signature_is_refused() {
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let (account, signer) = w.account_of(build, &key);
        let good = w.transfer_signature(&key, &account, 7, AMOUNT);

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
    let account = Address::generate(&w.env);

    let ed25519_key = ed25519_dalek::SigningKey::from_bytes(&[0x23; 32]);
    let ed25519_signer = Signer::External(
        ed25519_verifier,
        Bytes::from_array(&w.env, ed25519_key.verifying_key().as_bytes()),
    );
    let ethereum_key = ethereum_key(0x17);
    let ethereum_signer = w.ethereum_signer(&ethereum_key, &account);

    let policies: Map<Address, Val> = map![
        &w.env,
        (
            threshold_policy.clone(),
            SimpleThresholdAccountParams { threshold: 1 }.into_val(&w.env)
        )
    ];
    w.deploy(
        build,
        &account,
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
            t.w.transfer_signature(&t.ethereum_key, &t.account, 7, AMOUNT);
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
        let payload = t.w.transfer_payload(&t.account, 7, AMOUNT);
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
        let payload = t.w.transfer_payload(&t.account, 7, AMOUNT);
        let signatures = [
            (
                t.ed25519_signer.clone(),
                t.ed25519_key.sign(&payload).to_bytes().to_vec(),
            ),
            (
                t.ethereum_signer.clone(),
                ethereum_signature(&t.ethereum_key, &t.account, &payload),
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
            t.w.transfer_signature(&ethereum_key(0x42), &t.account, 7, AMOUNT);
        let signatures = [(t.ethereum_signer.clone(), forged)];
        assert_eq!(
            t.w.check_transfer(&t.account, 7, AMOUNT, &signatures),
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

#[test]
fn signer_added_to_an_existing_account_signs_next_to_the_others() {
    // The account exists, so its id is known when the second signer's key
    // data is built. The current signer authorises `add_signer`, a call of
    // the account on itself, through the same path as any other call.
    for build in BUILDS {
        let w = world();
        let first_key = ethereum_key(0x17);
        let second_key = ethereum_key(0x42);
        let (account, first) = w.account_of(build, &first_key);
        let second = w.ethereum_signer(&second_key, &account);
        let adding = w.add_signer_invocation(&account, &second);
        let payload = verifier_payload(3, &adding);

        // Not without the account's authorisation, and not with another key's.
        w.env.set_auths(&[]);
        assert!(w.call_add_signer(&account, &second).is_err(), "{build:?}");
        let forged = ethereum_signature(&second_key, &account, &payload);
        w.env
            .set_auths(&[w.entry(&account, 3, &adding, &[(first.clone(), forged)])]);
        assert!(w.call_add_signer(&account, &second).is_err(), "{build:?}");
        assert_eq!(w.rule(&account).signers, vec![&w.env, first.clone()]);

        let signature = ethereum_signature(&first_key, &account, &payload);
        w.env
            .set_auths(&[w.entry(&account, 3, &adding, &[(first.clone(), signature)])]);
        assert_eq!(w.call_add_signer(&account, &second), Ok(1), "{build:?}");
        assert_eq!(
            w.rule(&account).signers,
            vec![&w.env, first.clone(), second.clone()]
        );

        // The rule has no policy, so it now takes both signatures.
        let payload = w.transfer_payload(&account, 7, AMOUNT);
        let by_first = (
            first.clone(),
            ethereum_signature(&first_key, &account, &payload),
        );
        let by_second = (
            second.clone(),
            ethereum_signature(&second_key, &account, &payload),
        );
        for alone in [&by_first, &by_second] {
            assert_eq!(
                w.check_transfer(&account, 7, AMOUNT, core::slice::from_ref(alone)),
                Err(Ok(SmartAccountError::UnvalidatedContext)),
                "{build:?}"
            );
            assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT, core::slice::from_ref(alone)));
        }
        // Each signature under the other signer.
        let swapped = [
            (first.clone(), by_second.1.clone()),
            (second.clone(), by_first.1.clone()),
        ];
        assert!(!w.transfer(&account, 7, AMOUNT, AMOUNT, &swapped));
        assert_eq!(w.balance(&account), BALANCE);

        assert!(
            w.transfer(&account, 7, AMOUNT, AMOUNT, &[by_first, by_second]),
            "{build:?}"
        );
        assert_eq!(w.balance(&account), BALANCE - AMOUNT);
    }
}

#[test]
fn account_refuses_the_same_address_twice() {
    // The account asks the verifier for the canonical form of each key and
    // refuses a rule that would hold one key twice. The canonical form is
    // the Ethereum address, so the same address is refused whatever account
    // id follows it.
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let (account, signer) = w.account_of(build, &key);

        assert_eq!(
            w.add_signer_unchecked(&account, &signer),
            Err(Ok(SmartAccountError::DuplicateSigner)),
            "{build:?}"
        );
        let elsewhere = w.ethereum_signer(&key, &Address::generate(&w.env));
        assert_ne!(elsewhere, signer);
        assert_eq!(
            w.add_signer_unchecked(&account, &elsewhere),
            Err(Ok(SmartAccountError::DuplicateSigner)),
            "{build:?}"
        );
        assert_eq!(w.rule(&account).signers, vec![&w.env, signer.clone()]);

        let second = w.ethereum_signer(&ethereum_key(0x42), &account);
        assert_eq!(
            w.add_signer_unchecked(&account, &second),
            Ok(1),
            "{build:?}"
        );
        assert_eq!(w.rule(&account).signers, vec![&w.env, signer, second]);
    }
}

#[test]
fn account_refuses_key_data_of_the_wrong_length() {
    for build in BUILDS {
        let w = world();
        let (account, signer) = w.account_of(build, &ethereum_key(0x17));

        let address = eth_address(&ethereum_key(0x42));
        let full = key_data(&address, &id_of(&account));
        let mut padded = [0u8; 32];
        padded[12..].copy_from_slice(&address);
        // The bare address, the address padded to an EVM word, the account
        // id alone, and one byte short.
        for bad in [&address[..], &padded[..], &full[20..], &full[..51]] {
            let signer = Signer::External(w.verifier.clone(), Bytes::from_slice(&w.env, bad));
            assert_eq!(
                w.add_signer_unchecked(&account, &signer),
                Err(Err(InvokeError::Contract(
                    EvmVerifierError::BadKeyLength as u32
                ))),
                "{build:?}, {} bytes",
                bad.len()
            );
        }
        assert_eq!(w.rule(&account).signers, vec![&w.env, signer]);

        let well_formed = Signer::External(w.verifier.clone(), Bytes::from_array(&w.env, &full));
        assert_eq!(
            w.add_signer_unchecked(&account, &well_formed),
            Ok(1),
            "{build:?}"
        );
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

/// Two accounts asked to authorise the same call under the same nonce. With
/// legacy credentials their Soroban payloads are the same 32 bytes, so the
/// verifier is all that can tell their signatures apart.
struct TwoAccounts {
    w: World,
    gate: Address,
    first: Address,
    second: Address,
    opening: SorobanAuthorizedInvocation,
    /// What both accounts hand to the verifier.
    payload: [u8; 32],
}

impl TwoAccounts {
    fn new(w: World, first: Address, second: Address) -> Self {
        let gate = w.env.register(Gate, ());
        let opening = invocation(
            &gate,
            "open",
            std::vec![w.sc_val(&first), w.sc_val(&second)],
        );
        let payload = verifier_payload(7, &opening);
        TwoAccounts {
            w,
            gate,
            first,
            second,
            opening,
            payload,
        }
    }

    /// Attempts the call with one entry per account.
    fn open(&self, first: &Signatures, second: &Signatures) -> bool {
        self.w.env.set_auths(&[
            self.w.entry(&self.first, 7, &self.opening, first),
            self.w.entry(&self.second, 7, &self.opening, second),
        ]);
        self.w
            .env
            .try_invoke_contract::<(), soroban_sdk::Error>(
                &self.gate,
                &Symbol::new(&self.w.env, "open"),
                vec![
                    &self.w.env,
                    self.first.into_val(&self.w.env),
                    self.second.into_val(&self.w.env),
                ],
            )
            .is_ok()
    }

    /// What `account` answers for its entry.
    fn check(&self, account: &Address, signatures: &Signatures) -> Checked {
        let context = Context::Contract(ContractContext {
            contract: self.gate.clone(),
            fn_name: Symbol::new(&self.w.env, "open"),
            args: vec![
                &self.w.env,
                self.first.into_val(&self.w.env),
                self.second.into_val(&self.w.env),
            ],
        });
        self.w
            .env
            .try_invoke_contract_check_auth::<SmartAccountError>(
                account,
                &BytesN::from_array(&self.w.env, &soroban_payload(7, &self.opening)),
                self.w.auth_payload(signatures).into_val(&self.w.env),
                &vec![&self.w.env, context],
            )
    }
}

#[test]
fn signature_for_one_account_fails_on_another_that_lists_the_same_address() {
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let (first, first_signer) = w.account_of(build, &key);
        let (second, second_signer) = w.account_of(build, &key);
        let t = TwoAccounts::new(w, first, second);

        // Same key, same 32 bytes, and still two signatures.
        let for_first = ethereum_signature(&key, &t.first, &t.payload);
        let for_second = ethereum_signature(&key, &t.second, &t.payload);
        assert_ne!(for_first, for_second);
        let first_ok = [(first_signer.clone(), for_first.clone())];

        // The first account's signature under the second account's signer.
        let replayed = [(second_signer.clone(), for_first.clone())];
        assert_eq!(
            t.check(&t.second, &replayed),
            Err(Ok(SmartAccountError::ExternalVerificationFailed)),
            "{build:?}"
        );
        assert!(!t.open(&first_ok, &replayed), "{build:?}");

        // The first account's signature under the first account's signer:
        // not a signer the second account has.
        let transplanted = [(first_signer.clone(), for_first.clone())];
        assert_eq!(
            t.check(&t.second, &transplanted),
            Err(Ok(SmartAccountError::UnvalidatedContext)),
            "{build:?}"
        );
        assert!(!t.open(&first_ok, &transplanted), "{build:?}");

        // Each account under its own signature.
        assert!(
            t.open(&first_ok, &[(second_signer, for_second)]),
            "{build:?}"
        );
    }
}

#[test]
fn the_account_named_is_the_one_registered_not_the_caller() {
    // What the binding does not give. The verifier cannot see who calls it:
    // it checks the signature against the account id in the key data. An
    // account whose signer was registered with another account's id accepts
    // the signatures made for that other account, and refuses the ones made
    // for itself.
    for build in BUILDS {
        let w = world();
        let key = ethereum_key(0x17);
        let (first, first_signer) = w.account_of(build, &key);

        // The second account lists the same key under the first one's id.
        let second = Address::generate(&w.env);
        let misregistered = w.ethereum_signer(&key, &first);
        assert_eq!(misregistered, first_signer);
        w.deploy(
            build,
            &second,
            vec![&w.env, misregistered.clone()],
            map![&w.env],
        );
        let t = TwoAccounts::new(w, first, second);

        let for_first = ethereum_signature(&key, &t.first, &t.payload);
        let for_second = ethereum_signature(&key, &t.second, &t.payload);
        let first_ok = [(first_signer.clone(), for_first.clone())];

        assert_eq!(
            t.check(&t.second, &[(misregistered.clone(), for_second.clone())]),
            Err(Ok(SmartAccountError::ExternalVerificationFailed)),
            "{build:?}"
        );
        assert!(
            !t.open(&first_ok, &[(misregistered.clone(), for_second)]),
            "{build:?}"
        );
        assert!(
            t.open(&first_ok, &[(misregistered, for_first)]),
            "{build:?}"
        );
    }
}
