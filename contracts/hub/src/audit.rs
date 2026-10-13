//! Tests from the security review in `docs/AUDIT.md`.
//!
//! Every test here passes, and a pass does not mean "safe". Read the name:
//!
//! * `f…` tests demonstrate a documented limit of the deployed hub, or of
//!   the accounts it deploys. The id is the finding in `docs/AUDIT.md`. What
//!   the test asserts is the weakness itself.
//! * `n…` tests demonstrate an attack that was tried and is refused. The id
//!   is the rejected hypothesis in `docs/AUDIT.md`.
//!
//! The deployed code cannot be changed, so none of the limits shown here can
//! be patched. The tests are deterministic and need no network. They load
//! the compiled contracts: run `stellar contract build` before `cargo test`.
//!
//! Circle's TokenMessengerMinter is replaced by a stand-in. Tests that
//! depend on how Circle's contract behaves say which behaviour the stand-in
//! copies.

extern crate std;

use std::{string::String, vec::Vec as StdVec};

use k256::ecdsa::SigningKey;
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    testutils::{Address as _, Deployer as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    xdr::{
        self, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits,
        ScAddress, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
        SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, WriteXdr,
    },
    Address, BytesN, Env,
};

use crate::{PasoHub, PasoHubClient};

/// The account contract as compiled by `stellar contract build`.
mod account {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/paso_account.wasm");
}

/// The hub as compiled by `stellar contract build`.
const HUB_WASM: &[u8] = include_bytes!("../../../target/wasm32v1-none/release/paso_hub.wasm");

const NETWORK_ID: [u8; 32] = [0x5a; 32];
const BASE_DOMAIN: u32 = 6;
const FAST_FINALITY: u32 = 1000;

/// What the stand-in messenger was last asked to do.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Seen {
    pub amount: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub max_fee: i128,
    pub min_finality_threshold: u32,
}

/// A stand-in for Circle's TokenMessengerMinter with three switches:
///
/// * `keep`: how many units of an amount it leaves with its caller, the way
///   Circle's contract leaves the part of an amount it does not burn;
/// * a denylist checked on `caller`, which is where Circle's
///   `deposit_for_burn` applies its own;
/// * `call_back`: whether it calls its caller again before it returns.
///
/// It validates nothing else.
#[contract]
struct Messenger;

#[contractimpl]
impl Messenger {
    pub fn set_keep(env: Env, keep: i128) {
        env.storage().instance().set(&symbol_short!("keep"), &keep);
    }

    pub fn denylist(env: Env, who: Address) {
        env.storage().persistent().set(&who, &true);
    }

    pub fn set_call_back(env: Env, on: bool) {
        env.storage().instance().set(&symbol_short!("callback"), &on);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn deposit_for_burn(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        _destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    ) {
        caller.require_auth();
        if env.storage().persistent().has(&caller) {
            panic!("caller is denylisted");
        }
        let keep: i128 = env
            .storage()
            .instance()
            .get(&symbol_short!("keep"))
            .unwrap_or(0);
        let taken = amount - keep;

        let this = env.current_contract_address();
        let token = TokenClient::new(&env, &burn_token);
        token.transfer_from(&this, &caller, &this, &taken);
        token.burn(&this, &taken);

        let call_back: bool = env
            .storage()
            .instance()
            .get(&symbol_short!("callback"))
            .unwrap_or(false);
        if call_back {
            // The most harmless call there is: a read that needs no
            // authorisation.
            PasoHubClient::new(&env, &caller).address_of(&BytesN::from_array(&env, &[0x99; 20]));
        }

        env.storage().instance().set(
            &symbol_short!("seen"),
            &Seen {
                amount,
                destination_domain,
                mint_recipient,
                max_fee,
                min_finality_threshold,
            },
        );
    }

    pub fn seen(env: Env) -> Option<Seen> {
        env.storage().instance().get(&symbol_short!("seen"))
    }
}

/// A hub wired to a USDC token and the stand-in messenger.
struct World {
    env: Env,
    hub: Address,
    usdc: Address,
    messenger: Address,
}

impl World {
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_network_id(NETWORK_ID);
        let account_wasm = env.deployer().upload_contract_wasm(account::WASM);
        let usdc = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let messenger = env.register(Messenger, ());
        let hub = env.register(PasoHub, (account_wasm, usdc.clone(), messenger.clone()));
        World {
            env,
            hub,
            usdc,
            messenger,
        }
    }

    fn hub(&self) -> PasoHubClient<'_> {
        PasoHubClient::new(&self.env, &self.hub)
    }

    fn usdc(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.usdc)
    }

    fn messenger(&self) -> MessengerClient<'_> {
        MessengerClient::new(&self.env, &self.messenger)
    }

    /// Mints USDC to `to`, then goes back to enforcing authorisation.
    fn fund(&self, to: &Address, amount: i128) {
        self.env.mock_all_auths();
        StellarAssetClient::new(&self.env, &self.usdc).mint(to, &amount);
        self.env.set_auths(&[]);
    }

    fn recipient(&self) -> BytesN<32> {
        let mut padded = [0u8; 32];
        padded[12..].copy_from_slice(&[0xab; 20]);
        BytesN::from_array(&self.env, &padded)
    }

    /// An authorisation entry for `hub.exit(account, amount, …)` and the USDC
    /// transfer nested in it, signed by `key` as EIP-712 typed data.
    fn signed_exit(
        &self,
        account: &Address,
        key: &SigningKey,
        amount: i128,
        nonce: i64,
        expiration: u32,
    ) -> SorobanAuthorizationEntry {
        let from = ScVal::Address(ScAddress::from(account));
        let hub = ScVal::Address(ScAddress::from(&self.hub));
        let recipient = self.recipient();

        let invocation = SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::from(&self.hub),
                function_name: "exit".try_into().unwrap(),
                args: std::vec![
                    from.clone(),
                    ScVal::from(amount),
                    ScVal::U32(BASE_DOMAIN),
                    ScVal::Bytes(recipient.to_array().to_vec().try_into().unwrap()),
                    ScVal::from(0i128),
                    ScVal::U32(FAST_FINALITY),
                ]
                .try_into()
                .unwrap(),
            }),
            sub_invocations: std::vec![SorobanAuthorizedInvocation {
                function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                    contract_address: ScAddress::from(&self.usdc),
                    function_name: "transfer".try_into().unwrap(),
                    args: std::vec![from, hub, ScVal::from(amount)].try_into().unwrap(),
                }),
                sub_invocations: Default::default(),
            }]
            .try_into()
            .unwrap(),
        };

        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(NETWORK_ID),
            nonce,
            signature_expiration_ledger: expiration,
            invocation: invocation.clone(),
        });
        let payload: [u8; 32] = Sha256::digest(preimage.to_xdr(Limits::none()).unwrap()).into();

        let me = strkey(account);
        let calls = [
            (
                strkey(&self.hub),
                "exit",
                std::vec![
                    me.clone(),
                    std::format!("{amount}"),
                    "6".into(),
                    std::format!("0x{}{}", "00".repeat(12), "ab".repeat(20)),
                    "0".into(),
                    "1000".into(),
                ],
            ),
            (
                strkey(&self.usdc),
                "transfer",
                std::vec![me.clone(), strkey(&self.hub), std::format!("{amount}")],
            ),
        ];
        let digest = reference_digest(&me, &calls, &payload);
        let (signature, recovery_id) = key.sign_prehash_recoverable(&digest).unwrap();
        let mut signature = signature.to_bytes().to_vec();
        signature.push(27 + recovery_id.to_byte());

        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(account),
                nonce,
                signature_expiration_ledger: expiration,
                signature: ScVal::Bytes(signature.try_into().unwrap()),
            }),
            root_invocation: invocation,
        }
    }

    /// Submits `hub.exit(account, amount, …)` with one entry attached. True
    /// if the exit went through.
    fn submit(&self, account: &Address, entry: &SorobanAuthorizationEntry, amount: i128) -> bool {
        self.env.set_auths(core::slice::from_ref(entry));
        self.hub()
            .try_exit(
                account,
                &amount,
                &BASE_DOMAIN,
                &self.recipient(),
                &0,
                &FAST_FINALITY,
            )
            .is_ok()
    }
}

fn strkey(address: &Address) -> String {
    let text = address.to_string();
    let mut out = std::vec![0u8; text.len() as usize];
    text.copy_into_slice(&mut out);
    String::from_utf8(out).unwrap()
}

fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

fn eth_address(key: &SigningKey) -> [u8; 20] {
    let point = key.verifying_key().to_encoded_point(false);
    keccak(&point.as_bytes()[1..])[12..].try_into().unwrap()
}

/// EIP-712 digest of an authorisation, computed with no contract code.
fn reference_digest(
    account: &str,
    calls: &[(String, &str, StdVec<String>)],
    payload: &[u8; 32],
) -> [u8; 32] {
    let call_type = keccak(b"Call(string contract,string fn,string[] args)");
    let mut call_hashes = StdVec::new();
    for (contract, function, args) in calls {
        let arg_hashes: StdVec<u8> = args.iter().flat_map(|arg| keccak(arg.as_bytes())).collect();
        let encoded = [
            call_type,
            keccak(contract.as_bytes()),
            keccak(function.as_bytes()),
            keccak(&arg_hashes),
        ]
        .concat();
        call_hashes.extend_from_slice(&keccak(&encoded));
    }
    let message = keccak(
        &[
            keccak(
                b"Authorization(string account,Call[] calls,bytes32 payload)Call(string contract,string fn,string[] args)",
            ),
            keccak(account.as_bytes()),
            keccak(&call_hashes),
            *payload,
        ]
        .concat(),
    );
    let domain = keccak(
        &[
            keccak(b"EIP712Domain(string name,string version,bytes32 salt)"),
            keccak(b"Paso"),
            keccak(b"1"),
            NETWORK_ID,
        ]
        .concat(),
    );
    keccak(&[&[0x19, 0x01], domain.as_slice(), message.as_slice()].concat())
}

/// An account deployed through the hub, and the key of its owner.
struct Twin {
    world: World,
    key: SigningKey,
    address: Address,
}

impl Twin {
    fn new() -> Self {
        let world = World::new();
        let key = SigningKey::from_slice(&[0x17; 32]).unwrap();
        let owner = BytesN::from_array(&world.env, &eth_address(&key));
        let address = world.hub().deploy(&owner);
        Twin {
            world,
            key,
            address,
        }
    }

    /// An entry for `hub.exit(amount)` signed by the owner.
    fn signed_exit(&self, amount: i128, nonce: i64, expiration: u32) -> SorobanAuthorizationEntry {
        self.world
            .signed_exit(&self.address, &self.key, amount, nonce, expiration)
    }

    fn submit(&self, entry: &SorobanAuthorizationEntry, amount: i128) -> bool {
        self.world.submit(&self.address, entry, amount)
    }
}

// ---------------------------------------------------------------------------
// F-01. Accounts of addresses that no key controls.
// ---------------------------------------------------------------------------

/// F-01. `deploy` and `address_of` take any twenty bytes. The account of an
/// Ethereum address that no private key controls (here the address of the
/// USDC token contract on Base) deploys like any other and holds USDC like
/// any other. The only way to authorise anything from it is a secp256k1
/// signature that recovers to those twenty bytes. No key is known for the
/// address of a contract, so whatever is sent there stays there.
///
/// The test shows the open door: the deposit is accepted. It shows the shut
/// one for a single arbitrary key. It cannot show it for every key; that
/// part rests on the address not being derived from a key at all.
#[test]
fn f01_account_of_a_keyless_address_accepts_funds_it_can_never_spend() {
    let world = World::new();
    let base_usdc: [u8; 20] = [
        0x83, 0x35, 0x89, 0xfc, 0xd6, 0xed, 0xb6, 0xe0, 0x8f, 0x4c, 0x7c, 0x32, 0xd4, 0xf7, 0x1b,
        0x54, 0xbd, 0xa0, 0x29, 0x13,
    ];
    let owner = BytesN::from_array(&world.env, &base_usdc);

    // It can be paid before it is deployed, and deployed by anyone.
    let predicted = world.hub().address_of(&owner);
    world.fund(&predicted, 30_000_000);
    let twin = world.hub().deploy(&owner);
    assert_eq!(twin, predicted);
    assert_eq!(account::Client::new(&world.env, &twin).owner(), owner);
    assert_eq!(world.usdc().balance(&twin), 30_000_000);

    // Nothing gets the money out: with no authorisation, and with the
    // signature of a key that is not the owner's.
    world.env.set_auths(&[]);
    let unauthorised = world.hub().try_exit(
        &twin,
        &10_000_000,
        &BASE_DOMAIN,
        &world.recipient(),
        &0,
        &FAST_FINALITY,
    );
    assert!(unauthorised.is_err());

    let some_key = SigningKey::from_slice(&[0x17; 32]).unwrap();
    assert_ne!(eth_address(&some_key), base_usdc);
    let entry = world.signed_exit(&twin, &some_key, 10_000_000, 1, 1000);
    assert!(!world.submit(&twin, &entry, 10_000_000));
    assert_eq!(world.usdc().balance(&twin), 30_000_000);
}

// ---------------------------------------------------------------------------
// F-02. What a signature is worth after its transaction failed.
// ---------------------------------------------------------------------------

/// F-02. A transaction that fails rolls the nonce back with everything else.
/// The signed entry, which is public from then on, stays valid until its
/// expiry ledger, and anyone can submit it again. Here an exit fails because
/// the account is empty; the account is funded later, and the old entry goes
/// through.
#[test]
fn f02_failed_transaction_leaves_the_signature_usable_by_anyone() {
    let twin = Twin::new();
    let amount = 20_000_000;
    let entry = twin.signed_exit(amount, 1, 100_000);

    // The account is empty: the signature is fine, the transfer is not.
    assert!(!twin.submit(&entry, amount));

    // Later the account is funded for some other purpose.
    twin.world.fund(&twin.address, 50_000_000);
    twin.world.env.ledger().set_sequence_number(50_000);

    // The old entry, taken from the failed transaction, now goes through.
    assert!(twin.submit(&entry, amount));
    assert_eq!(twin.world.usdc().balance(&twin.address), 30_000_000);
}

/// F-02. There is no revoke function. The only way to cancel a signed entry
/// is to spend its nonce with another entry, and that holds only while the
/// host keeps the nonce record. The record lives as long as the
/// replacement's expiry, not the original's. A short-lived replacement
/// blocks a long-lived signature for a while; then the signature works
/// again.
#[test]
fn f02_cancelling_by_spending_the_nonce_wears_off() {
    let twin = Twin::new();
    twin.world.fund(&twin.address, 50_000_000);
    let env = &twin.world.env;
    let now = env.ledger().sequence();
    let min_temp_ttl = env.ledger().get().min_temp_entry_ttl;

    let nonce = 42;
    let long_lived = twin.signed_exit(20_000_000, nonce, now + 500_000);
    let replacement = twin.signed_exit(10, nonce, now + 20);

    assert!(twin.submit(&replacement, 10));
    assert!(!twin.submit(&long_lived, 20_000_000), "cancelled, for now");
    assert_eq!(twin.world.usdc().balance(&twin.address), 49_999_990);

    // Once the nonce record has expired the long-lived signature works again.
    env.ledger()
        .set_sequence_number(now + min_temp_ttl.max(20) + 1);
    assert!(twin.submit(&long_lived, 20_000_000), "live again");
    assert_eq!(twin.world.usdc().balance(&twin.address), 29_999_990);
}

// ---------------------------------------------------------------------------
// F-05. Lifetimes.
// ---------------------------------------------------------------------------

/// F-05. Using an account extends no lifetime. The account's instance, the
/// account code and the hub's instance each count down one ledger at a time
/// from the lifetime they were created with. A successful exit, which runs
/// the hub, the account's `__check_auth` and the shared account code, leaves
/// all three exactly where they were.
#[test]
fn f05_using_an_account_extends_no_lifetime() {
    let twin = Twin::new();
    twin.world.fund(&twin.address, 50_000_000);
    let env = &twin.world.env;
    let lifetimes = || {
        (
            env.deployer().get_contract_instance_ttl(&twin.address),
            env.deployer().get_contract_code_ttl(&twin.address),
            env.deployer().get_contract_instance_ttl(&twin.world.hub),
        )
    };

    // Created with the network's minimum persistent lifetime.
    let created = lifetimes();
    let minimum = env.ledger().get().min_persistent_entry_ttl;
    assert_eq!(created, (minimum - 1, minimum - 1, minimum - 1));

    // Time passes: each entry is that much closer to being archived.
    let now = env.ledger().sequence();
    env.ledger().set_sequence_number(now + 1_000);
    let before = lifetimes();
    assert_eq!(
        before,
        (created.0 - 1_000, created.1 - 1_000, created.2 - 1_000)
    );

    // A successful exit changes none of them.
    let entry = twin.signed_exit(20_000_000, 1, now + 2_000);
    assert!(twin.submit(&entry, 20_000_000));
    assert_eq!(twin.world.usdc().balance(&twin.address), 30_000_000);
    assert_eq!(lifetimes(), before);
}

/// The `(module, field)` pair of every function a wasm file imports.
fn wasm_imports(wasm: &[u8]) -> StdVec<(String, String)> {
    fn leb(data: &[u8], at: &mut usize) -> usize {
        let (mut value, mut shift) = (0usize, 0);
        loop {
            let byte = data[*at];
            *at += 1;
            value |= ((byte & 0x7f) as usize) << shift;
            shift += 7;
            if byte & 0x80 == 0 {
                return value;
            }
        }
    }
    fn name(data: &[u8], at: &mut usize) -> String {
        let len = leb(data, at);
        let text = String::from_utf8(data[*at..*at + len].to_vec()).unwrap();
        *at += len;
        text
    }

    assert_eq!(&wasm[..4], b"\0asm");
    let mut out = StdVec::new();
    let mut at = 8;
    while at < wasm.len() {
        let kind = wasm[at];
        at += 1;
        let size = leb(wasm, &mut at);
        // Section 2 is the import section.
        if kind == 2 {
            let section = &wasm[at..at + size];
            let mut cursor = 0;
            for _ in 0..leb(section, &mut cursor) {
                let module = name(section, &mut cursor);
                let field = name(section, &mut cursor);
                assert_eq!(section[cursor], 0, "only functions are imported");
                cursor += 1;
                leb(section, &mut cursor);
                out.push((module, field));
            }
        }
        at += size;
    }
    out
}

fn imports(wasm: &[u8], module: &str, field: &str) -> bool {
    wasm_imports(wasm)
        .iter()
        .any(|(m, f)| m == module && f == field)
}

// Import names of Soroban host functions in protocol 29, from `env.json` of
// `soroban-env-common` 29.0.0.
const CALL: (&str, &str) = ("d", "_");
const CREATE_CONTRACT_WITH_CONSTRUCTOR: (&str, &str) = ("l", "e");
const UPDATE_CURRENT_CONTRACT_WASM: (&str, &str) = ("l", "6");
/// `extend_contract_data_ttl`, `extend_current_contract_instance_and_code_ttl`,
/// `extend_contract_instance_and_code_ttl`, `extend_contract_instance_ttl`,
/// `extend_contract_code_ttl`, `extend_contract_data_ttl_v2`,
/// `extend_contract_instance_and_code_ttl_v2`.
const TTL_EXTENSIONS: [(&str, &str); 7] = [
    ("l", "7"),
    ("l", "8"),
    ("l", "9"),
    ("l", "c"),
    ("l", "d"),
    ("l", "f"),
    ("l", "g"),
];

/// F-05. The compiled hub imports none of the host functions that extend the
/// lifetime of a ledger entry. `deploy` and `exit` keep nothing alive: not
/// the hub, not the account code, not the account being used. Someone has to
/// pay for an extension from outside.
#[test]
fn f05_hub_code_never_extends_the_lifetime_of_anything() {
    // The parser sees the imports that must be there.
    assert!(imports(HUB_WASM, CALL.0, CALL.1));
    assert!(imports(
        HUB_WASM,
        CREATE_CONTRACT_WITH_CONSTRUCTOR.0,
        CREATE_CONTRACT_WITH_CONSTRUCTOR.1
    ));

    for (module, field) in TTL_EXTENSIONS {
        assert!(!imports(HUB_WASM, module, field), "{module}.{field}");
    }
}

// ---------------------------------------------------------------------------
// F-06, F-09, F-10. The hub and Circle's contract.
// ---------------------------------------------------------------------------

/// F-06. The hub is the `caller` of every burn, so the messenger's denylist
/// is applied to the hub and never to the account that is leaving. One
/// denylist entry for the hub stops `exit` for every account at once. An
/// account that approves and calls the messenger itself is not affected:
/// two calls, where `exit` takes one.
///
/// The stand-in checks its denylist on `caller`, as Circle's contract does.
#[test]
fn f06_one_denylist_entry_for_the_hub_stops_exit_for_every_account() {
    let world = World::new();
    let alice = Address::generate(&world.env);
    let bob = Address::generate(&world.env);
    world.fund(&alice, 50_000_000);
    world.fund(&bob, 50_000_000);
    world.env.mock_all_auths();

    world.hub().exit(
        &alice,
        &10_000_000,
        &BASE_DOMAIN,
        &world.recipient(),
        &0,
        &FAST_FINALITY,
    );

    world.messenger().denylist(&world.hub);
    for from in [&alice, &bob] {
        let refused = world.hub().try_exit(
            from,
            &10_000_000,
            &BASE_DOMAIN,
            &world.recipient(),
            &0,
            &FAST_FINALITY,
        );
        assert!(refused.is_err());
    }
    assert_eq!(world.usdc().balance(&alice), 40_000_000);
    assert_eq!(world.usdc().balance(&bob), 50_000_000);

    // The way out that remains: approve and burn directly, two calls.
    let expiry = world.env.ledger().sequence();
    world
        .usdc()
        .approve(&alice, &world.messenger, &10_000_000, &expiry);
    world.messenger().deposit_for_burn(
        &alice,
        &10_000_000,
        &BASE_DOMAIN,
        &world.recipient(),
        &world.usdc,
        &BytesN::from_array(&world.env, &[0; 32]),
        &0,
        &FAST_FINALITY,
    );
    assert_eq!(world.usdc().balance(&alice), 30_000_000);
}

/// F-09. The hub cannot give anything back. Whatever the messenger does not
/// take stays in the hub for good, and so does USDC sent to the hub by
/// mistake. No function moves the hub's balance, and a later exit neither
/// sweeps nor refunds it.
///
/// The stand-in is told to leave 100 units of every amount with its caller.
/// Circle's contract takes the full amount under its configuration on
/// mainnet as of 2026-10-12.
#[test]
fn f09_hub_keeps_for_good_what_the_messenger_leaves_and_what_is_sent_to_it() {
    let world = World::new();
    let alice = Address::generate(&world.env);
    let bob = Address::generate(&world.env);
    world.fund(&alice, 50_000_000);
    world.fund(&bob, 50_000_000);

    // Someone pays the hub instead of an account.
    world.fund(&world.hub, 7_000_000);

    // The messenger starts leaving 100 units of every amount with its caller.
    world.messenger().set_keep(&100);

    world.env.mock_all_auths();
    world.hub().exit(
        &alice,
        &20_000_000,
        &BASE_DOMAIN,
        &world.recipient(),
        &0,
        &FAST_FINALITY,
    );
    assert_eq!(world.usdc().balance(&alice), 30_000_000);
    assert_eq!(world.usdc().balance(&world.hub), 7_000_100);

    // A later exit neither sweeps nor refunds it.
    world.hub().exit(
        &bob,
        &10_000_000,
        &BASE_DOMAIN,
        &world.recipient(),
        &0,
        &FAST_FINALITY,
    );
    assert_eq!(world.usdc().balance(&bob), 40_000_000);
    assert_eq!(world.usdc().balance(&world.hub), 7_000_200);

    // Time does not move it either.
    world
        .env
        .ledger()
        .set_sequence_number(world.env.ledger().sequence() + 1);
    assert_eq!(world.usdc().balance(&world.hub), 7_000_200);
}

/// F-09. The hub cannot be named as `from` in `exit`: nothing can authorise
/// for the hub's own address, because the hub has no `__check_auth`. A
/// balance that ends up in the hub cannot be exited either.
#[test]
fn f09_hub_cannot_exit_its_own_balance() {
    let world = World::new();
    world.fund(&world.hub, 7_000_000);

    // No entry at all.
    world.env.set_auths(&[]);
    let refused = world.hub().try_exit(
        &world.hub,
        &7_000_000,
        &BASE_DOMAIN,
        &world.recipient(),
        &0,
        &FAST_FINALITY,
    );
    assert!(refused.is_err());

    // An entry that claims to be the hub's.
    world.env.set_auths(&[SorobanAuthorizationEntry {
        credentials: SorobanCredentials::Address(SorobanAddressCredentials {
            address: ScAddress::from(&world.hub),
            nonce: 1,
            signature_expiration_ledger: 100,
            signature: ScVal::Void,
        }),
        root_invocation: SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::from(&world.hub),
                function_name: "exit".try_into().unwrap(),
                args: std::vec![
                    ScVal::Address(ScAddress::from(&world.hub)),
                    ScVal::from(7_000_000i128),
                    ScVal::U32(BASE_DOMAIN),
                    ScVal::Bytes(world.recipient().to_array().to_vec().try_into().unwrap()),
                    ScVal::from(0i128),
                    ScVal::U32(FAST_FINALITY),
                ]
                .try_into()
                .unwrap(),
            }),
            sub_invocations: Default::default(),
        },
    }]);
    let refused = world.hub().try_exit(
        &world.hub,
        &7_000_000,
        &BASE_DOMAIN,
        &world.recipient(),
        &0,
        &FAST_FINALITY,
    );
    assert!(refused.is_err());
    assert_eq!(world.usdc().balance(&world.hub), 7_000_000);
}

/// F-10. The hub checks the sign and the seventh decimal of the two amounts
/// and nothing else. A fee cap far above the amount, a zero recipient, an
/// unknown domain and a zero finality threshold all reach the messenger as
/// given. Whether such an exit is refused, or burns USDC that cannot be
/// minted on the other side, is decided by Circle's contract alone.
#[test]
fn f10_hub_forwards_fee_cap_recipient_domain_and_finality_unchecked() {
    let world = World::new();
    let alice = Address::generate(&world.env);
    world.fund(&alice, 50_000_000);
    world.env.mock_all_auths();

    let zero = BytesN::from_array(&world.env, &[0; 32]);
    world.hub().exit(
        &alice,
        &10,
        &u32::MAX,
        &zero,
        &9_000_000_000_000_000_000,
        &0,
    );
    assert_eq!(
        world.messenger().seen(),
        Some(Seen {
            amount: 10,
            destination_domain: u32::MAX,
            mint_recipient: zero,
            max_fee: 9_000_000_000_000_000_000,
            min_finality_threshold: 0,
        })
    );
    assert_eq!(world.usdc().balance(&alice), 49_999_990);
}

// ---------------------------------------------------------------------------
// N-05, N-06, N-07, N-08. Attacks on the hub that are refused.
// ---------------------------------------------------------------------------

/// N-05. Deploying someone's account before they do gives the deployer
/// nothing. The address is fixed by the hub and the owner's twenty bytes,
/// and the constructor receives the same twenty bytes. Here a stranger
/// deploys the account with no authorisation at all. The stored owner is
/// still the owner, a second `deploy` returns the same address, the
/// stranger's signature is refused and the owner's is accepted.
#[test]
fn n05_deploying_an_account_before_its_owner_gives_the_deployer_nothing() {
    let world = World::new();
    let owner_key = SigningKey::from_slice(&[0x17; 32]).unwrap();
    let stranger_key = SigningKey::from_slice(&[0x42; 32]).unwrap();
    let owner = BytesN::from_array(&world.env, &eth_address(&owner_key));

    let predicted = world.hub().address_of(&owner);
    world.fund(&predicted, 50_000_000);

    world.env.set_auths(&[]);
    let deployed = world.hub().deploy(&owner);
    assert_eq!(deployed, predicted);
    assert_eq!(account::Client::new(&world.env, &deployed).owner(), owner);
    assert_eq!(world.hub().deploy(&owner), predicted);

    let forged = world.signed_exit(&deployed, &stranger_key, 20_000_000, 1, 1000);
    assert!(!world.submit(&deployed, &forged, 20_000_000));
    assert_eq!(world.usdc().balance(&deployed), 50_000_000);

    let genuine = world.signed_exit(&deployed, &owner_key, 20_000_000, 1, 1000);
    assert!(world.submit(&deployed, &genuine, 20_000_000));
    assert_eq!(world.usdc().balance(&deployed), 30_000_000);
}

/// N-06. The allowance the hub gives the messenger is for one amount and
/// for the current ledger. Here the messenger leaves 100 units unburned, so
/// that part of the allowance stays unused. A third party cannot draw on
/// it: the allowance names the messenger as spender and nobody else. From
/// the next ledger on it reads as zero and is worth nothing even to the
/// messenger.
#[test]
fn n06_unused_allowance_is_out_of_a_third_partys_reach_and_ends_with_the_ledger() {
    let world = World::new();
    let alice = Address::generate(&world.env);
    let stranger = Address::generate(&world.env);
    world.fund(&alice, 50_000_000);
    world.messenger().set_keep(&100);

    world.env.mock_all_auths();
    world.hub().exit(
        &alice,
        &20_000_000,
        &BASE_DOMAIN,
        &world.recipient(),
        &0,
        &FAST_FINALITY,
    );
    assert_eq!(world.usdc().balance(&world.hub), 100);
    assert_eq!(world.usdc().allowance(&world.hub, &world.messenger), 100);

    // Same ledger: a third party is not a spender.
    assert_eq!(world.usdc().allowance(&world.hub, &stranger), 0);
    assert!(world
        .usdc()
        .try_transfer_from(&stranger, &world.hub, &stranger, &100)
        .is_err());

    // Next ledger: the allowance is gone, also for the messenger. Its
    // authorisation is mocked here; on chain only the messenger contract
    // could give it.
    world
        .env
        .ledger()
        .set_sequence_number(world.env.ledger().sequence() + 1);
    assert_eq!(world.usdc().allowance(&world.hub, &world.messenger), 0);
    assert!(world
        .usdc()
        .try_transfer_from(&world.messenger, &world.hub, &stranger, &100)
        .is_err());
    assert_eq!(world.usdc().balance(&world.hub), 100);
}

/// N-07. The messenger cannot call back into the hub while an exit is
/// running: the host refuses to re-enter a contract that is on the call
/// stack. The stand-in tries the most harmless call there is, the read
/// `address_of`, and the whole exit fails and moves nothing. With the
/// call-back switched off the same exit goes through.
#[test]
fn n07_messenger_cannot_call_back_into_the_hub_during_an_exit() {
    let world = World::new();
    let alice = Address::generate(&world.env);
    world.fund(&alice, 50_000_000);
    world.env.mock_all_auths();
    let exit = || {
        world
            .hub()
            .try_exit(
                &alice,
                &10_000_000,
                &BASE_DOMAIN,
                &world.recipient(),
                &0,
                &FAST_FINALITY,
            )
            .is_ok()
    };

    world.messenger().set_call_back(&true);
    assert!(!exit());
    assert_eq!(world.usdc().balance(&alice), 50_000_000);
    assert_eq!(world.usdc().balance(&world.hub), 0);
    assert_eq!(world.messenger().seen(), None);

    world.messenger().set_call_back(&false);
    assert!(exit());
    assert_eq!(world.usdc().balance(&alice), 40_000_000);
}

/// N-08. The compiled hub cannot replace its own code: it does not import
/// the host function that does that. The same absence is why a bug in it
/// cannot be patched.
#[test]
fn n08_hub_code_cannot_replace_itself() {
    assert!(imports(HUB_WASM, CALL.0, CALL.1));
    assert!(!imports(
        HUB_WASM,
        UPDATE_CURRENT_CONTRACT_WASM.0,
        UPDATE_CURRENT_CONTRACT_WASM.1
    ));
    // Nor can the account code every account runs.
    assert!(!imports(
        account::WASM,
        UPDATE_CURRENT_CONTRACT_WASM.0,
        UPDATE_CURRENT_CONTRACT_WASM.1
    ));
}
