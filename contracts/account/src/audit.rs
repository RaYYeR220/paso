//! Tests from the security review in `docs/AUDIT.md`.
//!
//! Every test here passes, and a pass does not mean "safe". Read the name:
//!
//! * `f…` tests demonstrate a documented limit of the deployed account
//!   contract. The id is the finding in `docs/AUDIT.md`. What the test
//!   asserts is the weakness itself.
//! * `n…` tests demonstrate an attack that was tried and is refused. The id
//!   is the rejected hypothesis in `docs/AUDIT.md`.
//!
//! The deployed code cannot be changed, so none of the limits shown here can
//! be patched. The tests are deterministic and need no network. Some of them
//! load the compiled account contract: run `stellar contract build` before
//! `cargo test`.

extern crate std;

use std::{println, string::String, vec::Vec as StdVec};

use k256::{
    ecdsa::SigningKey,
    elliptic_curve::{point::DecompressPoint, subtle::Choice},
    AffinePoint,
};
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl,
    testutils::{Address as _, Ledger as _, MuxedAddress as _},
    vec,
    xdr::{
        self, HashIdPreimage, HashIdPreimageSorobanAuthorization,
        HashIdPreimageSorobanAuthorizationWithAddress, InvokeContractArgs, Limits, ScAddress,
        ScVal, SorobanAddressCredentials, SorobanAddressCredentialsWithDelegates,
        SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
        SorobanCredentials, SorobanDelegateSignature, WriteXdr,
    },
    Address, Bytes, BytesN, Env, IntoVal, InvokeError, MuxedAddress, Symbol, Val, Vec,
};

use crate::{eip712, render, AccountError, PasoAccount};

/// The account contract as compiled by `stellar contract build`.
mod wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/paso_account.wasm");
}

const NETWORK_ID: [u8; 32] = [0x5a; 32];

const DOMAIN_TYPE: &[u8] = b"EIP712Domain(string name,string version,bytes32 salt)";
const AUTHORIZATION_TYPE: &[u8] =
    b"Authorization(string account,Call[] calls,bytes32 payload)Call(string contract,string fn,string[] args)";
const CALL_TYPE: &[u8] = b"Call(string contract,string fn,string[] args)";

type CheckResult = Result<(), Result<AccountError, InvokeError>>;

const BAD_SIGNATURE: CheckResult = Err(Ok(AccountError::BadSignature));

fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

fn std_bytes(bytes: &Bytes) -> StdVec<u8> {
    bytes.iter().collect()
}

fn strkey(address: &Address) -> String {
    let text = address.to_string();
    let mut out = std::vec![0u8; text.len() as usize];
    text.copy_into_slice(&mut out);
    String::from_utf8(out).unwrap()
}

fn eth_address(key: &SigningKey) -> [u8; 20] {
    let point = key.verifying_key().to_encoded_point(false);
    keccak(&point.as_bytes()[1..])[12..].try_into().unwrap()
}

fn sign(key: &SigningKey, digest: &[u8; 32]) -> [u8; 65] {
    let (signature, recovery_id) = key.sign_prehash_recoverable(digest).unwrap();
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&signature.to_bytes());
    out[64] = 27 + recovery_id.to_byte();
    out
}

/// One call as the wallet displays it. Arguments are raw bytes, so that
/// text that is not UTF-8 can be expressed.
struct TextCall {
    contract: String,
    function: String,
    args: StdVec<StdVec<u8>>,
}

/// `hashStruct(Authorization)`, computed with no contract code.
fn struct_hash(account: &str, calls: &[TextCall], payload: &[u8; 32]) -> [u8; 32] {
    let mut call_hashes = StdVec::new();
    for call in calls {
        let arg_hashes: StdVec<u8> = call.args.iter().flat_map(|arg| keccak(arg)).collect();
        let encoded = [
            keccak(CALL_TYPE),
            keccak(call.contract.as_bytes()),
            keccak(call.function.as_bytes()),
            keccak(&arg_hashes),
        ]
        .concat();
        call_hashes.extend_from_slice(&keccak(&encoded));
    }
    keccak(
        &[
            keccak(AUTHORIZATION_TYPE),
            keccak(account.as_bytes()),
            keccak(&call_hashes),
            *payload,
        ]
        .concat(),
    )
}

fn domain_separator(name: &[u8], version: &[u8], salt: &[u8; 32]) -> [u8; 32] {
    keccak(&[keccak(DOMAIN_TYPE), keccak(name), keccak(version), *salt].concat())
}

/// `0x19 0x01 ‖ domainSeparator ‖ hashStruct`: the 66 bytes whose keccak256
/// the owner signs.
fn signing_preimage(domain: &[u8; 32], message: &[u8; 32]) -> StdVec<u8> {
    [&[0x19, 0x01], domain.as_slice(), message.as_slice()].concat()
}

/// The EIP-712 digest of an authorisation on the test network, computed with
/// no contract code.
fn reference_digest(account: &str, calls: &[TextCall], payload: &[u8; 32]) -> [u8; 32] {
    keccak(&signing_preimage(
        &domain_separator(b"Paso", b"1", &NETWORK_ID),
        &struct_hash(account, calls, payload),
    ))
}

fn check(
    env: &Env,
    account: &Address,
    payload: [u8; 32],
    signature: [u8; 65],
    contexts: &Vec<Context>,
) -> CheckResult {
    env.try_invoke_contract_check_auth::<AccountError>(
        account,
        &BytesN::from_array(env, &payload),
        BytesN::from_array(env, &signature).into_val(env),
        contexts,
    )
}

fn text_of(env: &Env, value: &Val) -> String {
    String::from_utf8_lossy(&std_bytes(&render::text(env, value))).into_owned()
}

/// A contract whose one function needs the authorisation of `who`.
#[contract]
struct Target;

#[contractimpl]
impl Target {
    pub fn act(_env: Env, who: Address, _tag: u32) {
        who.require_auth();
    }
}

/// An account, the key of its owner, and a contract for it to call.
struct World {
    env: Env,
    key: SigningKey,
    account: Address,
    target: Address,
}

impl World {
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_network_id(NETWORK_ID);
        let key = SigningKey::from_slice(&[0x17; 32]).unwrap();
        let account = env.register(PasoAccount, (BytesN::from_array(&env, &eth_address(&key)),));
        let target = env.register(Target, ());
        World {
            env,
            key,
            account,
            target,
        }
    }

    /// The call `target.act(account, tag)` as an authorised invocation.
    fn invocation(&self, tag: u32) -> SorobanAuthorizedInvocation {
        SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::from(&self.target),
                function_name: "act".try_into().unwrap(),
                args: std::vec![
                    ScVal::Address(ScAddress::from(&self.account)),
                    ScVal::U32(tag)
                ]
                .try_into()
                .unwrap(),
            }),
            sub_invocations: Default::default(),
        }
    }

    /// The same call as the text the owner signs.
    fn calls(&self, tag: u32) -> [TextCall; 1] {
        [TextCall {
            contract: strkey(&self.target),
            function: "act".into(),
            args: std::vec![
                strkey(&self.account).into_bytes(),
                std::format!("{tag}").into_bytes()
            ],
        }]
    }

    /// The same call as the contexts the host hands to `__check_auth`.
    fn contexts(&self, tag: u32) -> Vec<Context> {
        vec![
            &self.env,
            Context::Contract(ContractContext {
                contract: self.target.clone(),
                fn_name: Symbol::new(&self.env, "act"),
                args: vec![
                    &self.env,
                    self.account.to_val(),
                    tag.into_val(&self.env)
                ],
            }),
        ]
    }

    /// Payload of an entry in the legacy credential encoding (`Address`).
    fn payload_v1(&self, tag: u32, nonce: i64, expiration: u32) -> [u8; 32] {
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(NETWORK_ID),
            nonce,
            signature_expiration_ledger: expiration,
            invocation: self.invocation(tag),
        });
        Sha256::digest(preimage.to_xdr(Limits::none()).unwrap()).into()
    }

    /// Payload of an entry in the address-bound encoding (`AddressV2`), which
    /// `AddressWithDelegates` shares.
    fn payload_v2(&self, tag: u32, nonce: i64, expiration: u32) -> [u8; 32] {
        let preimage = HashIdPreimage::SorobanAuthorizationWithAddress(
            HashIdPreimageSorobanAuthorizationWithAddress {
                network_id: xdr::Hash(NETWORK_ID),
                nonce,
                signature_expiration_ledger: expiration,
                address: ScAddress::from(&self.account),
                invocation: self.invocation(tag),
            },
        );
        Sha256::digest(preimage.to_xdr(Limits::none()).unwrap()).into()
    }

    fn signature_over(&self, tag: u32, payload: &[u8; 32]) -> [u8; 65] {
        sign(
            &self.key,
            &reference_digest(&strkey(&self.account), &self.calls(tag), payload),
        )
    }

    fn credentials(
        &self,
        nonce: i64,
        expiration: u32,
        signature: [u8; 65],
    ) -> SorobanAddressCredentials {
        SorobanAddressCredentials {
            address: ScAddress::from(&self.account),
            nonce,
            signature_expiration_ledger: expiration,
            signature: ScVal::Bytes(signature.to_vec().try_into().unwrap()),
        }
    }

    /// Runs `target.act(account, tag)` through the host's own authorisation
    /// path with one entry attached. True if the call went through.
    fn run(&self, tag: u32, credentials: SorobanCredentials) -> bool {
        self.env.set_auths(&[SorobanAuthorizationEntry {
            credentials,
            root_invocation: self.invocation(tag),
        }]);
        TargetClient::new(&self.env, &self.target)
            .try_act(&self.account, &tag)
            .is_ok()
    }
}

// ---------------------------------------------------------------------------
// F-02. The lifetime of a signature.
// ---------------------------------------------------------------------------

/// F-02. The expiry is compared with the ledger when the entry is used, not
/// when it is signed. An expiry further away than the network's
/// `max_entry_ttl` is refused today and accepted once the chain has come
/// within range. That setting bounds how wide the window is in which a
/// signature works. It does not bound how far in the future the window lies,
/// and nothing in the wallet prompt shows the expiry.
#[test]
fn f02_far_expiry_signature_is_refused_today_and_accepted_later() {
    let world = World::new();
    let now = world.env.ledger().sequence();
    let max_entry_ttl = world.env.ledger().get().max_entry_ttl;
    let (nonce, tag) = (77i64, 4u32);
    let expiration = now + 2 * max_entry_ttl;
    let signature = world.signature_over(tag, &world.payload_v2(tag, nonce, expiration));
    let credentials =
        || SorobanCredentials::AddressV2(world.credentials(nonce, expiration, signature));

    assert!(
        !world.run(tag, credentials()),
        "refused while the expiry is out of range"
    );

    world
        .env
        .ledger()
        .set_sequence_number(now + max_entry_ttl + 10);
    assert!(
        world.run(tag, credentials()),
        "accepted once the chain is within range"
    );
}

/// F-02. A signature stays usable up to and including the ledger named as
/// its expiry. Anyone who holds the signed entry can submit it at any point
/// in that window. It is refused in the ledger after, and it works once.
#[test]
fn f02_signature_is_live_through_its_expiry_ledger_and_dead_in_the_next() {
    let (nonce, expiration, tag) = (11i64, 1000u32, 4u32);

    let world = World::new();
    world.env.ledger().set_sequence_number(expiration + 1);
    let signature = world.signature_over(tag, &world.payload_v2(tag, nonce, expiration));
    assert!(!world.run(
        tag,
        SorobanCredentials::AddressV2(world.credentials(nonce, expiration, signature))
    ));

    let world = World::new();
    world.env.ledger().set_sequence_number(expiration);
    let signature = world.signature_over(tag, &world.payload_v2(tag, nonce, expiration));
    assert!(world.run(
        tag,
        SorobanCredentials::AddressV2(world.credentials(nonce, expiration, signature))
    ));
    // And only once.
    assert!(!world.run(
        tag,
        SorobanCredentials::AddressV2(world.credentials(nonce, expiration, signature))
    ));
}

// ---------------------------------------------------------------------------
// F-04, F-07, F-13. What the displayed text does and does not say.
// ---------------------------------------------------------------------------

/// F-04. A muxed address has no text form: it is displayed as `xdr:` and a
/// hash. The token interface takes a muxed address as the destination of
/// `transfer`, so the recipient of a plain token transfer can be a value the
/// owner cannot read. The account accepts a signature over that text.
#[test]
fn f04_transfer_to_a_muxed_address_shows_the_recipient_as_a_hash() {
    let world = World::new();
    let env = &world.env;
    let muxed = MuxedAddress::generate(env);
    let text = text_of(env, muxed.as_val());
    println!(
        "muxed recipient {:?} is displayed as {text}",
        muxed.to_strkey()
    );
    assert!(text.starts_with("xdr:") && text.len() == 4 + 64);

    // The account authorises a transfer whose recipient the owner cannot read.
    let token = Address::generate(env);
    let amount = 50_000_000i128;
    let contexts = vec![
        env,
        Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(env, "transfer"),
            args: vec![
                env,
                world.account.to_val(),
                muxed.to_val(),
                amount.into_val(env)
            ],
        }),
    ];
    let payload = [0x33; 32];
    let calls = [TextCall {
        contract: strkey(&token),
        function: "transfer".into(),
        args: std::vec![
            strkey(&world.account).into_bytes(),
            text.clone().into_bytes(),
            b"50000000".to_vec()
        ],
    }];
    let signature = sign(
        &world.key,
        &reference_digest(&strkey(&world.account), &calls, &payload),
    );
    assert_eq!(
        check(env, &world.account, payload, signature, &contexts),
        Ok(())
    );
}

/// F-07. The text carries no type. Each group below is one string in the
/// wallet, produced by values of different Soroban types.
#[test]
fn f07_values_of_different_types_are_displayed_as_the_same_text() {
    let env = Env::default();
    let s = |text: &str| -> Val { soroban_sdk::String::from_str(&env, text).to_val() };
    let sym = |text: &str| -> Val { Symbol::new(&env, text).to_val() };

    let contract = Address::from_str(
        &env,
        "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG",
    );
    let classic = Address::from_str(
        &env,
        "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
    );
    let list: Val = vec![&env, 1u32, 2u32, 3u32].into_val(&env);
    let list_text = text_of(&env, &list);
    assert!(list_text.starts_with("xdr:"));

    let groups: StdVec<(&str, StdVec<Val>)> = std::vec![
        (
            "5",
            std::vec![
                5u32.into_val(&env),
                5i32.into_val(&env),
                5u64.into_val(&env),
                5i64.into_val(&env),
                5u128.into_val(&env),
                5i128.into_val(&env),
                s("5"),
                sym("5"),
            ],
        ),
        (
            "-5",
            std::vec![(-5i32).into_val(&env), (-5i128).into_val(&env), s("-5")]
        ),
        (
            "true",
            std::vec![true.into_val(&env), s("true"), sym("true")]
        ),
        ("void", std::vec![().into_val(&env), s("void"), sym("void")]),
        (
            "0xdeadbeef",
            std::vec![
                Bytes::from_array(&env, &[0xde, 0xad, 0xbe, 0xef]).to_val(),
                BytesN::from_array(&env, &[0xde, 0xad, 0xbe, 0xef]).to_val(),
                s("0xdeadbeef"),
            ],
        ),
        (
            "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG",
            std::vec![
                contract.to_val(),
                s("CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG"),
            ],
        ),
        (
            "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
            std::vec![
                classic.to_val(),
                s("GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR"),
            ],
        ),
        // A hashed value and a string that spells out the same hash.
        (list_text.as_str(), std::vec![list, s(&list_text)]),
    ];

    for (expected, values) in &groups {
        for (i, value) in values.iter().enumerate() {
            assert_eq!(
                &text_of(&env, value),
                expected,
                "group {expected}, value {i}"
            );
        }
    }
}

/// F-07. With `payload` held equal, a call with typed arguments (an address,
/// an `i128`, a `bool`) and a call with a string and a symbol that spell the
/// same characters give one digest, so one displayed message. In a real
/// entry the two payloads differ, which is what keeps a signature for one
/// from authorising the other, but the payload is 32 bytes of hex to the
/// person signing.
#[test]
fn f07_calls_with_differently_typed_arguments_give_one_displayed_message() {
    let env = Env::default();
    env.ledger().set_network_id(NETWORK_ID);
    let account = env.register(PasoAccount, (BytesN::from_array(&env, &[1; 20]),));
    let target = Address::generate(&env);
    let recipient = Address::generate(&env);
    let payload = BytesN::from_array(&env, &[0x22; 32]);

    let typed = vec![
        &env,
        Context::Contract(ContractContext {
            contract: target.clone(),
            fn_name: Symbol::new(&env, "pay"),
            args: vec![
                &env,
                recipient.to_val(),
                1_000_000i128.into_val(&env),
                true.into_val(&env)
            ],
        }),
    ];
    let stringly = vec![
        &env,
        Context::Contract(ContractContext {
            contract: target.clone(),
            fn_name: Symbol::new(&env, "pay"),
            args: vec![
                &env,
                recipient.to_string().to_val(),
                soroban_sdk::String::from_str(&env, "1000000").to_val(),
                Symbol::new(&env, "true").to_val(),
            ],
        }),
    ];
    let (a, b) = env.as_contract(&account, || {
        (
            eip712::digest(&env, &payload, &typed).unwrap().to_array(),
            eip712::digest(&env, &payload, &stringly)
                .unwrap()
                .to_array(),
        )
    });
    assert_eq!(a, b);
}

/// F-07. The call list is flat. The trees `a → [b, c]` and `a → [b → [c]]`
/// are different authorisations and give the same list of calls, in the same
/// order. Only `payload` tells them apart.
#[test]
fn f07_call_list_does_not_show_which_call_is_nested_in_which() {
    let world = World::new();
    let leaf =
        |tag: u32, subs: StdVec<SorobanAuthorizedInvocation>| SorobanAuthorizedInvocation {
            sub_invocations: subs.try_into().unwrap(),
            ..world.invocation(tag)
        };
    let wide = leaf(1, std::vec![leaf(2, std::vec![]), leaf(3, std::vec![])]);
    let deep = leaf(1, std::vec![leaf(2, std::vec![leaf(3, std::vec![])])]);
    assert_ne!(
        wide.to_xdr(Limits::none()).unwrap(),
        deep.to_xdr(Limits::none()).unwrap()
    );

    // The contexts the host derives are the pre-order walk, identical for both.
    fn walk(node: &SorobanAuthorizedInvocation, out: &mut StdVec<StdVec<u8>>) {
        out.push(node.function.to_xdr(Limits::none()).unwrap());
        for sub in node.sub_invocations.iter() {
            walk(sub, out);
        }
    }
    let (mut a, mut b) = (StdVec::new(), StdVec::new());
    walk(&wide, &mut a);
    walk(&deep, &mut b);
    assert_eq!(a, b);
}

/// F-07. A `String` argument is hashed byte for byte. Line breaks, text
/// shaped like further fields, a right-to-left override and a zero-width
/// space all reach the wallet as they are, and the account accepts a
/// signature over them. How a wallet draws such a string is not tested here.
#[test]
fn f07_string_arguments_reach_the_wallet_with_control_characters_intact() {
    let world = World::new();
    let env = &world.env;
    let hostile = "ok\n\npayload: 0x0000000000000000000000000000000000000000000000000000000000000000\n\
                   \u{202e}DCSU 1 evieceR\u{202c}\u{200b}";
    let value = soroban_sdk::String::from_str(env, hostile);
    assert_eq!(
        std_bytes(&render::text(env, value.as_val())),
        hostile.as_bytes()
    );

    let contexts = vec![
        env,
        Context::Contract(ContractContext {
            contract: world.target.clone(),
            fn_name: Symbol::new(env, "note"),
            args: vec![env, value.to_val()],
        }),
    ];
    let payload = [0x44; 32];
    let calls = [TextCall {
        contract: strkey(&world.target),
        function: "note".into(),
        args: std::vec![hostile.as_bytes().to_vec()],
    }];
    let signature = sign(
        &world.key,
        &reference_digest(&strkey(&world.account), &calls, &payload),
    );
    assert_eq!(
        check(env, &world.account, payload, signature, &contexts),
        Ok(())
    );
}

/// F-07. Every value outside the rendering table is displayed as `xdr:` and
/// a hash: 256-bit integers, timepoints, durations, errors, vectors, maps and
/// tuples. The owner cannot read any of them.
#[test]
fn f07_values_without_a_text_form_are_displayed_as_hashes() {
    use soroban_sdk::{map, Duration, Error, Timepoint, I256, U256};
    let env = Env::default();
    let values: StdVec<(&str, Val)> = std::vec![
        ("u256", U256::from_u32(&env, 5).to_val()),
        ("i256", I256::from_i32(&env, -5).to_val()),
        (
            "timepoint",
            Timepoint::from_unix(&env, 1_800_000_000).to_val()
        ),
        ("duration", Duration::from_seconds(&env, 60).to_val()),
        ("error", Error::from_contract_error(2).to_val()),
        (
            "vec of addresses",
            vec![&env, Address::generate(&env)].to_val()
        ),
        ("map", map![&env, (1u32, 2u32)].to_val()),
        (
            "tuple",
            (1u32, soroban_sdk::String::from_str(&env, "x")).into_val(&env)
        ),
    ];
    for (name, value) in values {
        let text = text_of(&env, &value);
        println!("{name:>18}: {text}");
        assert!(text.starts_with("xdr:") && text.len() == 68, "{name}");
    }
}

/// xorshift64*, so that the run is the same every time.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn bytes(&mut self, len: usize) -> StdVec<u8> {
        (0..len).map(|_| self.next() as u8).collect()
    }

    /// Biased towards the edges of the range.
    fn word(&mut self) -> u128 {
        let raw = ((self.next() as u128) << 64) | self.next() as u128;
        match self.next() % 8 {
            0 => 0,
            1 => u128::MAX,
            2 => 1u128 << 127,
            3 => (1u128 << 127) - 1,
            4 => raw >> (self.next() % 128),
            5 => !(raw >> (self.next() % 128)),
            _ => raw,
        }
    }
}

/// The text the table in `docs/ENCODING.md` prescribes, written from the
/// `ScVal` with Rust's own formatting. It shares no code with `render.rs`.
fn expected_text(value: &ScVal) -> StdVec<u8> {
    use std::string::ToString;
    match value {
        ScVal::Bool(b) => b.to_string().into_bytes(),
        ScVal::Void => b"void".to_vec(),
        ScVal::U32(n) => n.to_string().into_bytes(),
        ScVal::I32(n) => n.to_string().into_bytes(),
        ScVal::U64(n) => n.to_string().into_bytes(),
        ScVal::I64(n) => n.to_string().into_bytes(),
        ScVal::U128(p) => (((p.hi as u128) << 64) | p.lo as u128)
            .to_string()
            .into_bytes(),
        ScVal::I128(p) => (((p.hi as i128) << 64) | p.lo as i128)
            .to_string()
            .into_bytes(),
        ScVal::Bytes(b) => std::format!("0x{}", hex::encode(b.as_slice())).into_bytes(),
        ScVal::String(s) => s.as_slice().to_vec(),
        ScVal::Symbol(s) => s.as_slice().to_vec(),
        other => std::format!(
            "xdr:{}",
            hex::encode(Sha256::digest(other.to_xdr(Limits::none()).unwrap()))
        )
        .into_bytes(),
    }
}

/// F-07, the edge of it. The text collisions are between types, not within
/// one. On 6,000 generated values of fourteen kinds, with integer boundaries
/// and strings of arbitrary bytes among them, the contract's renderer gives
/// the text a second renderer written from the table gives, and no two
/// different values of one kind share a text. This is a sample, not a proof.
#[test]
fn f07_within_one_type_no_two_of_6000_generated_values_share_a_text() {
    use soroban_sdk::TryFromVal;
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let symbol_chars = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";

    let mut seen = std::collections::BTreeMap::<(u32, StdVec<u8>), StdVec<u8>>::new();
    for round in 0..6_000u32 {
        let word = rng.word();
        let kind = round % 14;
        let value = match kind {
            0 => ScVal::Bool(word & 1 == 1),
            1 => ScVal::Void,
            2 => ScVal::U32(word as u32),
            3 => ScVal::I32(word as i32),
            4 => ScVal::U64(word as u64),
            5 => ScVal::I64(word as i64),
            6 => ScVal::U128(xdr::UInt128Parts {
                hi: (word >> 64) as u64,
                lo: word as u64,
            }),
            7 => ScVal::I128(xdr::Int128Parts {
                hi: (word >> 64) as i64,
                lo: word as u64,
            }),
            8 => {
                let len = (rng.next() % 70) as usize;
                ScVal::Bytes(rng.bytes(len).try_into().unwrap())
            }
            9 => {
                // Any bytes at all, valid UTF-8 or not.
                let len = (rng.next() % 70) as usize;
                ScVal::String(xdr::ScString(rng.bytes(len).try_into().unwrap()))
            }
            10 => {
                let len = (rng.next() % 33) as usize;
                let text: StdVec<u8> = (0..len)
                    .map(|_| symbol_chars[(rng.next() % symbol_chars.len() as u64) as usize])
                    .collect();
                ScVal::Symbol(xdr::ScSymbol(text.try_into().unwrap()))
            }
            11 => ScVal::U256(xdr::UInt256Parts {
                hi_hi: rng.next(),
                hi_lo: rng.next(),
                lo_hi: rng.next(),
                lo_lo: rng.next(),
            }),
            12 => ScVal::Timepoint(xdr::TimePoint(word as u64)),
            _ => ScVal::Vec(Some(xdr::ScVec(
                std::vec![ScVal::U32(word as u32), ScVal::Bool(word & 2 == 2)]
                    .try_into()
                    .unwrap(),
            ))),
        };
        let host_value = Val::try_from_val(&env, &value).unwrap();
        let text = std_bytes(&render::text(&env, &host_value));
        assert_eq!(text, expected_text(&value), "round {round}: {value:?}");

        // Within one kind, two different values never share a text.
        let encoded = value.to_xdr(Limits::none()).unwrap();
        if let Some(previous) = seen.insert((kind, text), encoded.clone()) {
            assert_eq!(
                previous, encoded,
                "round {round}: two values of kind {kind}, one text"
            );
        }
    }
}

/// F-13. The contract hashes the bytes of a `String` exactly as they are: a
/// leading byte-order mark (`ef bb bf`) is part of the text, and so are
/// bytes that are not UTF-8. A signer has to hash the same bytes. One that
/// drops the mark while decoding signs a text the contract will not rebuild,
/// and that call fails with `BadSignature`.
#[test]
fn f13_contract_hashes_a_byte_order_mark_and_non_utf8_bytes_exactly_as_given() {
    let world = World::new();
    let env = &world.env;
    for raw in [&[0xff, 0xfe, 0x41][..], &[0xef, 0xbb, 0xbf, b'h', b'i'][..]] {
        let value = soroban_sdk::String::from_bytes(env, raw);
        assert_eq!(std_bytes(&render::text(env, value.as_val())), raw);

        let contexts = vec![
            env,
            Context::Contract(ContractContext {
                contract: world.target.clone(),
                fn_name: Symbol::new(env, "note"),
                args: vec![env, value.to_val()],
            }),
        ];
        let payload = [0x55; 32];
        let call = |text: &[u8]| {
            [TextCall {
                contract: strkey(&world.target),
                function: "note".into(),
                args: std::vec![text.to_vec()],
            }]
        };

        // Signed over the exact bytes: accepted.
        let signature = sign(
            &world.key,
            &reference_digest(&strkey(&world.account), &call(raw), &payload),
        );
        assert_eq!(
            check(env, &world.account, payload, signature, &contexts),
            Ok(())
        );
    }

    // Signed over the text with the byte-order mark dropped: refused.
    let value = soroban_sdk::String::from_bytes(env, &[0xef, 0xbb, 0xbf, b'h', b'i']);
    let contexts = vec![
        env,
        Context::Contract(ContractContext {
            contract: world.target.clone(),
            fn_name: Symbol::new(env, "note"),
            args: vec![env, value.to_val()],
        }),
    ];
    let payload = [0x55; 32];
    let stripped = [TextCall {
        contract: strkey(&world.target),
        function: "note".into(),
        args: std::vec![b"hi".to_vec()],
    }];
    let signature = sign(
        &world.key,
        &reference_digest(&strkey(&world.account), &stripped, &payload),
    );
    assert_eq!(
        check(env, &world.account, payload, signature, &contexts),
        BAD_SIGNATURE
    );
}

// ---------------------------------------------------------------------------
// F-08. The cost of `__check_auth`, measured on the compiled contract.
// ---------------------------------------------------------------------------

/// Mainnet at ledger 64,908,935 (2026-10-12): `tx_max_instructions` and
/// `tx_memory_limit` of the `contract_compute_v0` network setting.
const MAINNET_TX_INSTRUCTIONS: u64 = 400_000_000;
const MAINNET_TX_MEMORY: u64 = 41_943_040;

/// Instructions and memory charged for one `__check_auth` of the compiled
/// account contract over the calls `build_args` describes (one inner list
/// per call), and whether the check accepted the signature.
fn measure(build_args: impl Fn(&Env, &Address) -> StdVec<StdVec<Val>>) -> (u64, u64, bool) {
    let env = Env::default();
    env.cost_estimate().disable_resource_limits();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().set_network_id(NETWORK_ID);
    let key = SigningKey::from_slice(&[0x17; 32]).unwrap();
    let account = env.register(wasm::WASM, (BytesN::from_array(&env, &eth_address(&key)),));
    let target = Address::generate(&env);

    let mut contexts = Vec::new(&env);
    let mut calls = StdVec::new();
    for args in build_args(&env, &account) {
        let mut host_args = Vec::new(&env);
        let mut text_args = StdVec::new();
        for arg in &args {
            host_args.push_back(*arg);
            text_args.push(std_bytes(&render::text(&env, arg)));
        }
        contexts.push_back(Context::Contract(ContractContext {
            contract: target.clone(),
            fn_name: Symbol::new(&env, "call"),
            args: host_args,
        }));
        calls.push(TextCall {
            contract: strkey(&target),
            function: "call".into(),
            args: text_args,
        });
    }
    let payload = [0x66; 32];
    let signature = sign(&key, &reference_digest(&strkey(&account), &calls, &payload));

    env.cost_estimate().budget().reset_unlimited();
    let result = check(&env, &account, payload, signature, &contexts);
    let budget = env.cost_estimate().budget();
    (
        budget.cpu_instruction_cost(),
        budget.memory_bytes_cost(),
        result == Ok(()),
    )
}

fn percent(value: u64, limit: u64) -> f64 {
    100.0 * value as f64 / limit as f64
}

/// F-08. What `__check_auth` costs, against the mainnet limits for one
/// transaction. Run with `-- --nocapture` to print the table.
///
/// The memory charged for a `Bytes` argument grows with the square of its
/// length: 24,000 bytes fit under the limit and 26,000 do not. Strings and
/// long call lists are cheap by comparison.
#[test]
fn f08_memory_for_a_bytes_argument_grows_with_the_square_of_its_length() {
    println!(
        "limits: {MAINNET_TX_INSTRUCTIONS} instructions, {MAINNET_TX_MEMORY} bytes of memory"
    );

    // The shape of `hub.exit` with its nested transfer.
    let (cpu, mem, ok) = measure(|env, account| {
        std::vec![
            std::vec![
                account.to_val(),
                5_000_000i128.into_val(env),
                6u32.into_val(env),
                Bytes::from_array(env, &[0xab; 32]).to_val(),
                0i128.into_val(env),
                1000u32.into_val(env),
            ],
            std::vec![
                account.to_val(),
                account.to_val(),
                5_000_000i128.into_val(env)
            ],
        ]
    });
    println!(
        "exit-shaped (2 calls, 9 args): cpu {cpu} ({:.1}% of limit), mem {mem} ({:.1}%), accepted {ok}",
        percent(cpu, MAINNET_TX_INSTRUCTIONS),
        percent(mem, MAINNET_TX_MEMORY),
    );
    assert!(ok);
    assert!(percent(cpu, MAINNET_TX_INSTRUCTIONS) < 2.0);
    assert!(percent(mem, MAINNET_TX_MEMORY) < 5.0);

    for calls in [1usize, 10, 50, 100, 200, 400] {
        let (cpu, mem, ok) = measure(|env, account| {
            (0..calls)
                .map(|i| {
                    std::vec![
                        account.to_val(),
                        account.to_val(),
                        (i as i128).into_val(env)
                    ]
                })
                .collect()
        });
        println!(
            "{calls:>4} transfer-shaped calls: cpu {cpu:>11} ({:>5.1}% of limit), mem {mem:>10} ({:>5.1}%), accepted {ok}",
            percent(cpu, MAINNET_TX_INSTRUCTIONS),
            percent(mem, MAINNET_TX_MEMORY),
        );
        assert!(ok);
        assert!(mem < MAINNET_TX_MEMORY && cpu < MAINNET_TX_INSTRUCTIONS);
    }

    let bytes_of = |len: usize| {
        measure(move |env, _| {
            std::vec![std::vec![
                Bytes::from_slice(env, &std::vec![0x5au8; len]).to_val()
            ]]
        })
    };
    let mut memory = std::collections::BTreeMap::new();
    for len in [
        1_000usize, 4_000, 8_000, 16_000, 24_000, 26_000, 28_000, 32_000, 64_000,
    ] {
        let (cpu, mem, ok) = bytes_of(len);
        println!(
            "one Bytes argument of {len:>6} bytes: cpu {cpu:>11} ({:>5.1}% of limit), mem {mem:>10} ({:>6.1}%), accepted {ok}",
            percent(cpu, MAINNET_TX_INSTRUCTIONS),
            percent(mem, MAINNET_TX_MEMORY),
        );
        memory.insert(len, mem);
    }
    // Twice the length, more than three times the memory.
    assert!(memory[&16_000] > 3 * memory[&8_000]);
    assert!(memory[&32_000] > 3 * memory[&16_000]);
    assert!(memory[&64_000] > 3 * memory[&32_000]);
    // The limit falls between 24,000 and 26,000 bytes.
    assert!(memory[&24_000] < MAINNET_TX_MEMORY);
    assert!(memory[&26_000] > MAINNET_TX_MEMORY);

    // The squares add up over the arguments of one authorisation.
    for len in [16_000usize, 18_000, 19_000] {
        let (cpu, mem, ok) = measure(|env, _| {
            let blob = || Bytes::from_slice(env, &std::vec![0x5au8; len]).to_val();
            std::vec![std::vec![blob(), blob()]]
        });
        println!(
            "two Bytes arguments of {len:>5} bytes: cpu {cpu:>11} ({:>5.1}% of limit), mem {mem:>10} ({:>6.1}%), accepted {ok}",
            percent(cpu, MAINNET_TX_INSTRUCTIONS),
            percent(mem, MAINNET_TX_MEMORY),
        );
    }

    for len in [1_000usize, 32_000, 64_000, 100_000] {
        let (cpu, mem, ok) = measure(|env, _| {
            let text: std::string::String = core::iter::repeat('a').take(len).collect();
            std::vec![std::vec![
                soroban_sdk::String::from_str(env, &text).to_val()
            ]]
        });
        println!(
            "one String argument of {len:>6} bytes: cpu {cpu:>11} ({:>5.1}% of limit), mem {mem:>10} ({:>6.1}%), accepted {ok}",
            percent(cpu, MAINNET_TX_INSTRUCTIONS),
            percent(mem, MAINNET_TX_MEMORY),
        );
        assert!(ok);
        assert!(percent(mem, MAINNET_TX_MEMORY) < 10.0);
    }
}

/// F-08. With the mainnet limits enforced, a call that carries one `Bytes`
/// argument of 64,000 bytes cannot be authorised by a Paso account at all:
/// the signature check itself runs out of memory. 8,000 bytes pass.
#[test]
fn f08_call_with_a_64_kb_bytes_argument_can_never_be_authorised() {
    let run = |len: usize| -> bool {
        let env = Env::default();
        // The SDK's own limit check panics; the budget below reports the
        // same condition as an error instead.
        env.cost_estimate().disable_resource_limits();
        env.cost_estimate().budget().reset_unlimited();
        env.ledger().set_network_id(NETWORK_ID);
        let key = SigningKey::from_slice(&[0x17; 32]).unwrap();
        let account = env.register(wasm::WASM, (BytesN::from_array(&env, &eth_address(&key)),));
        let target = Address::generate(&env);
        let blob = std::vec![0x5au8; len];
        let value = Bytes::from_slice(&env, &blob);
        let contexts = vec![
            &env,
            Context::Contract(ContractContext {
                contract: target.clone(),
                fn_name: Symbol::new(&env, "call"),
                args: vec![&env, value.to_val()],
            }),
        ];
        let mut text = b"0x".to_vec();
        text.extend_from_slice(hex::encode(&blob).as_bytes());
        let calls = [TextCall {
            contract: strkey(&target),
            function: "call".into(),
            args: std::vec![text],
        }];
        let payload = [0x77; 32];
        let signature = sign(&key, &reference_digest(&strkey(&account), &calls, &payload));

        env.cost_estimate()
            .budget()
            .reset_limits(MAINNET_TX_INSTRUCTIONS, MAINNET_TX_MEMORY);
        check(&env, &account, payload, signature, &contexts) == Ok(())
    };
    assert!(run(8_000), "8 kB of bytes can be authorised");
    assert!(
        !run(64_000),
        "64 kB of bytes cannot: the check exceeds the memory limit"
    );
}

// ---------------------------------------------------------------------------
// F-11, F-12. What the signature does not bind.
// ---------------------------------------------------------------------------

/// F-11. The credential wrapper is not part of what is signed.
/// `AddressWithDelegates` credentials hash to the same payload as
/// `AddressV2`, so a signature the owner made for a V2 entry still verifies
/// after anyone re-wraps the entry with a list of delegates. The account
/// never consults the delegates. The same call runs, once: the nonce is
/// consumed all the same.
#[test]
fn f11_signature_still_verifies_after_anyone_rewraps_the_entry_with_delegates() {
    let (nonce, expiration, tag) = (9i64, 1000u32, 3u32);
    let world = World::new();
    let signature = world.signature_over(tag, &world.payload_v2(tag, nonce, expiration));

    let unrelated = Address::generate(&world.env);
    let wrapped =
        SorobanCredentials::AddressWithDelegates(SorobanAddressCredentialsWithDelegates {
            address_credentials: world.credentials(nonce, expiration, signature),
            delegates: std::vec![SorobanDelegateSignature {
                address: ScAddress::from(&unrelated),
                signature: ScVal::Void,
                nested_delegates: Default::default(),
            }]
            .try_into()
            .unwrap(),
        });
    assert!(world.run(tag, wrapped), "re-wrapped entry is accepted");

    // The original V2 entry is now spent.
    assert!(!world.run(
        tag,
        SorobanCredentials::AddressV2(world.credentials(nonce, expiration, signature))
    ));
}

/// F-11. The same `(r, s)` is accepted with a last byte of 27 or 0, and of
/// 28 or 1. One signature has two valid 65-byte spellings, so the bytes of a
/// signature are not a unique identifier. What stops a second use is the
/// nonce, which the host consumes, not the bytes.
#[test]
fn f11_one_signature_has_two_accepted_65_byte_spellings() {
    let world = World::new();
    let payload = [0x11; 32];
    let tag = 5;
    let contexts = world.contexts(tag);
    let mut signature = world.signature_over(tag, &payload);
    assert!(signature[64] == 27 || signature[64] == 28);
    assert_eq!(
        check(&world.env, &world.account, payload, signature, &contexts),
        Ok(())
    );
    signature[64] -= 27;
    assert_eq!(
        check(&world.env, &world.account, payload, signature, &contexts),
        Ok(())
    );
}

#[soroban_sdk::contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OuterError {
    Never = 1,
}

/// An account that checks no signature of its own and forwards the decision
/// to one fixed signer.
#[contract]
struct Outer;

#[contractimpl]
impl Outer {
    pub fn __constructor(env: Env, signer: Address) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("signer"), &signer);
    }
}

#[contractimpl]
impl soroban_sdk::auth::CustomAccountInterface for Outer {
    type Signature = ();
    type Error = OuterError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        _signature_payload: soroban_sdk::crypto::Hash<32>,
        _signature: (),
        _auth_contexts: Vec<Context>,
    ) -> Result<(), OuterError> {
        let signer: Address = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("signer"))
            .unwrap();
        env.custom_account().delegate_auth(&signer);
        Ok(())
    }
}

/// F-12. A Paso account works as a delegated signer of another account. The
/// message its owner signs then says `account: <the Paso account>` although
/// the authority being used is the other account's. Only the argument values
/// and the opaque payload say whose funds are in play.
#[test]
fn f12_as_a_delegated_signer_the_account_field_names_the_signer_not_the_spender() {
    let world = World::new();
    let env = &world.env;
    let outer = env.register(Outer, (world.account.clone(),));
    let (nonce, expiration, tag) = (5i64, 1000u32, 9u32);

    // `target.act(outer, 9)`: the authority needed is the outer account's.
    let invocation = SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: ScAddress::from(&world.target),
            function_name: "act".try_into().unwrap(),
            args: std::vec![ScVal::Address(ScAddress::from(&outer)), ScVal::U32(tag)]
                .try_into()
                .unwrap(),
        }),
        sub_invocations: Default::default(),
    };
    let preimage = HashIdPreimage::SorobanAuthorizationWithAddress(
        HashIdPreimageSorobanAuthorizationWithAddress {
            network_id: xdr::Hash(NETWORK_ID),
            nonce,
            signature_expiration_ledger: expiration,
            address: ScAddress::from(&outer),
            invocation: invocation.clone(),
        },
    );
    let payload: [u8; 32] = Sha256::digest(preimage.to_xdr(Limits::none()).unwrap()).into();

    // What the owner of the Paso account is shown and signs: `account` is the
    // Paso account.
    let calls = [TextCall {
        contract: strkey(&world.target),
        function: "act".into(),
        args: std::vec![strkey(&outer).into_bytes(), b"9".to_vec()],
    }];
    let signature = sign(
        &world.key,
        &reference_digest(&strkey(&world.account), &calls, &payload),
    );

    env.set_auths(&[SorobanAuthorizationEntry {
        credentials: SorobanCredentials::AddressWithDelegates(
            SorobanAddressCredentialsWithDelegates {
                address_credentials: SorobanAddressCredentials {
                    address: ScAddress::from(&outer),
                    nonce,
                    signature_expiration_ledger: expiration,
                    signature: ScVal::Void,
                },
                delegates: std::vec![SorobanDelegateSignature {
                    address: ScAddress::from(&world.account),
                    signature: ScVal::Bytes(signature.to_vec().try_into().unwrap()),
                    nested_delegates: Default::default(),
                }]
                .try_into()
                .unwrap(),
            },
        ),
        root_invocation: invocation,
    }]);
    assert!(TargetClient::new(env, &world.target)
        .try_act(&outer, &tag)
        .is_ok());
}

// ---------------------------------------------------------------------------
// F-05 and N-08. What the compiled contract can reach.
// ---------------------------------------------------------------------------

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
const PUT_CONTRACT_DATA: (&str, &str) = ("l", "_");
const RECOVER_KEY_ECDSA_SECP256K1: (&str, &str) = ("c", "2");
const UPDATE_CURRENT_CONTRACT_WASM: (&str, &str) = ("l", "6");
const CALL: (&str, &str) = ("d", "_");
const TRY_CALL: (&str, &str) = ("d", "0");
const REQUIRE_AUTH: (&str, &str) = ("a", "0");
const REQUIRE_AUTH_FOR_ARGS: (&str, &str) = ("a", "_");
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

/// F-05. The compiled account contract imports none of the host functions
/// that extend the lifetime of a ledger entry. Nothing an account does keeps
/// its own instance, or the code it shares with every other account, from
/// being archived. Someone has to pay for an extension from outside.
#[test]
fn f05_account_code_never_extends_the_lifetime_of_anything() {
    // The parser sees the imports that must be there.
    assert!(imports(
        wasm::WASM,
        RECOVER_KEY_ECDSA_SECP256K1.0,
        RECOVER_KEY_ECDSA_SECP256K1.1
    ));
    assert!(imports(
        wasm::WASM,
        PUT_CONTRACT_DATA.0,
        PUT_CONTRACT_DATA.1
    ));

    for (module, field) in TTL_EXTENSIONS {
        assert!(!imports(wasm::WASM, module, field), "{module}.{field}");
    }
}

/// N-08. The compiled account contract cannot replace its own code: it does
/// not import the host function that does that. It also imports no contract
/// call and no `require_auth`, so `__check_auth` can compute and compare and
/// nothing else. The same absence is why a bug in it cannot be patched.
#[test]
fn n08_account_code_cannot_replace_itself_or_call_another_contract() {
    assert!(imports(
        wasm::WASM,
        RECOVER_KEY_ECDSA_SECP256K1.0,
        RECOVER_KEY_ECDSA_SECP256K1.1
    ));

    for (module, field) in [
        UPDATE_CURRENT_CONTRACT_WASM,
        CALL,
        TRY_CALL,
        REQUIRE_AUTH,
        REQUIRE_AUTH_FOR_ARGS,
    ] {
        assert!(!imports(wasm::WASM, module, field), "{module}.{field}");
    }
}

// ---------------------------------------------------------------------------
// N-01, N-02, N-03. Attacks on the signature that are refused.
// ---------------------------------------------------------------------------

/// N-01. An `r` that is in range but is not the x-coordinate of a curve
/// point makes the host's key recovery fail, which fails the authorisation
/// with a host error. An `r` that is one recovers some other key and is
/// refused with `BadSignature`. Neither is accepted. The two ways of failing
/// are the ones `docs/ENCODING.md` section 9 describes.
#[test]
fn n01_r_off_the_curve_fails_in_the_host_and_r_on_the_curve_recovers_a_stranger() {
    let world = World::new();
    let (tag, payload) = (5u32, [0x11; 32]);
    let contexts = world.contexts(tag);
    let mut signature = world.signature_over(tag, &payload);

    let (mut on_curve, mut off_curve) = (0, 0);
    for byte in 1..=24u8 {
        let r = [byte; 32];
        signature[..32].copy_from_slice(&r);
        let is_x_coordinate: bool = AffinePoint::decompress(&r.into(), Choice::from(0))
            .is_some()
            .into();
        for recovery in [27, 28] {
            signature[64] = recovery;
            let result = check(&world.env, &world.account, payload, signature, &contexts);
            if is_x_coordinate {
                assert_eq!(result, BAD_SIGNATURE, "r = {byte:#04x} repeated");
            } else {
                assert!(
                    matches!(result, Err(Err(_))),
                    "r = {byte:#04x} repeated: {result:?}"
                );
            }
        }
        if is_x_coordinate {
            on_curve += 1;
        } else {
            off_curve += 1;
        }
    }
    assert!(on_curve > 0 && off_curve > 0);
}

/// N-02. A signature the owner makes with `personal_sign` is not a Paso
/// authorisation, whatever text they are asked to sign. The Paso preimage
/// starts with the bytes `19 01`, a `personal_sign` preimage with `19 45`
/// (`\x19Ethereum Signed Message:\n`), so the two digests can be equal only
/// through a keccak256 collision. The test has the owner `personal_sign` the
/// four texts an attacker would reach for and shows each one refused.
#[test]
fn n02_personal_sign_digest_is_never_a_paso_digest() {
    let world = World::new();
    let (tag, payload) = (5u32, [0x11; 32]);
    let contexts = world.contexts(tag);

    let paso_preimage = signing_preimage(
        &domain_separator(b"Paso", b"1", &NETWORK_ID),
        &struct_hash(&strkey(&world.account), &world.calls(tag), &payload),
    );
    let paso_digest = keccak(&paso_preimage);
    assert_eq!(paso_preimage[..2], [0x19, 0x01]);

    // Control: signed as EIP-712 typed data, the authorisation is accepted.
    assert_eq!(
        check(
            &world.env,
            &world.account,
            payload,
            sign(&world.key, &paso_digest),
            &contexts
        ),
        Ok(())
    );

    let personal_preimage = |text: &[u8]| -> StdVec<u8> {
        [
            b"\x19Ethereum Signed Message:\n".as_slice(),
            std::format!("{}", text.len()).as_bytes(),
            text,
        ]
        .concat()
    };
    let digest_as_hex_text = std::format!("0x{}", hex::encode(paso_digest));
    let texts: [&[u8]; 4] = [
        &paso_digest,
        digest_as_hex_text.as_bytes(),
        &paso_preimage,
        &paso_preimage[2..],
    ];
    for text in texts {
        let preimage = personal_preimage(text);
        assert_eq!(preimage[..2], [0x19, 0x45]);
        let digest = keccak(&preimage);
        assert_ne!(digest, paso_digest);
        assert_eq!(
            check(
                &world.env,
                &world.account,
                payload,
                sign(&world.key, &digest),
                &contexts
            ),
            BAD_SIGNATURE
        );
    }
}

/// N-02. The owner's EIP-712 signature over the very same `Authorization`
/// under any other domain is refused: another version, another name,
/// another salt, and a domain of the common `chainId` shape. A site cannot
/// collect a signature under a domain of its own and use it here.
#[test]
fn n02_signature_under_another_eip712_domain_is_refused() {
    let world = World::new();
    let (tag, payload) = (5u32, [0x11; 32]);
    let contexts = world.contexts(tag);
    let message = struct_hash(&strkey(&world.account), &world.calls(tag), &payload);

    let mut chain_id = [0u8; 32];
    chain_id[31] = 1;
    let with_chain_id = keccak(
        &[
            keccak(b"EIP712Domain(string name,string version,uint256 chainId)"),
            keccak(b"Paso"),
            keccak(b"1"),
            chain_id,
        ]
        .concat(),
    );
    let foreign_domains = [
        domain_separator(b"Paso", b"2", &NETWORK_ID),
        domain_separator(b"paso", b"1", &NETWORK_ID),
        domain_separator(b"Paso", b"1", &[0x5b; 32]),
        with_chain_id,
    ];
    for domain in foreign_domains {
        let digest = keccak(&signing_preimage(&domain, &message));
        assert_eq!(
            check(
                &world.env,
                &world.account,
                payload,
                sign(&world.key, &digest),
                &contexts
            ),
            BAD_SIGNATURE
        );
    }

    // Control: under the account's own domain the same message is accepted.
    let digest = keccak(&signing_preimage(
        &domain_separator(b"Paso", b"1", &NETWORK_ID),
        &message,
    ));
    assert_eq!(
        check(
            &world.env,
            &world.account,
            payload,
            sign(&world.key, &digest),
            &contexts
        ),
        Ok(())
    );
}

/// N-03. A signature does not move between credential encodings. The legacy
/// encoding (`Address`) and the address-bound one (`AddressV2`) hash to
/// different payloads. Each is accepted with a signature made over its own
/// payload and refused with a signature made over the other's.
#[test]
fn n03_signature_does_not_move_between_credential_encodings() {
    let (nonce, expiration, tag) = (7i64, 1000u32, 1u32);

    let world = World::new();
    let p1 = world.payload_v1(tag, nonce, expiration);
    let p2 = world.payload_v2(tag, nonce, expiration);
    assert_ne!(p1, p2);

    // V1 signature, V1 credentials: accepted.
    let s1 = world.signature_over(tag, &p1);
    assert!(world.run(
        tag,
        SorobanCredentials::Address(world.credentials(nonce, expiration, s1))
    ));

    // V2 signature, V2 credentials: accepted.
    let world = World::new();
    let s2 = world.signature_over(tag, &world.payload_v2(tag, nonce, expiration));
    assert!(world.run(
        tag,
        SorobanCredentials::AddressV2(world.credentials(nonce, expiration, s2))
    ));

    // Crossed: refused both ways.
    let world = World::new();
    let s1 = world.signature_over(tag, &world.payload_v1(tag, nonce, expiration));
    let s2 = world.signature_over(tag, &world.payload_v2(tag, nonce, expiration));
    assert!(!world.run(
        tag,
        SorobanCredentials::AddressV2(world.credentials(nonce, expiration, s1))
    ));
    assert!(!world.run(
        tag,
        SorobanCredentials::Address(world.credentials(nonce, expiration, s2))
    ));
}
