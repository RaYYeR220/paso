extern crate std;

use std::{string::String, vec::Vec as StdVec};

use base64::Engine as _;
use k256::ecdsa::SigningKey;
use serde::Deserialize;
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use soroban_sdk::{
    auth::{
        Context, ContractContext, ContractExecutable, CreateContractHostFnContext,
        CreateContractWithConstructorHostFnContext,
    },
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    vec,
    xdr::{
        self, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits,
        ReadXdr, ScAddress, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
        SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, ToXdr as _,
        WriteXdr,
    },
    Address, Bytes, BytesN, Env, IntoVal, InvokeError, Symbol, TryFromVal, Val, Vec,
};

use crate::{eip712, render, AccountError, PasoAccount, PasoAccountClient};

const DOMAIN_TYPE: &str = "EIP712Domain(string name,string version,bytes32 salt)";
const AUTHORIZATION_TYPE: &str =
    "Authorization(string account,Call[] calls,bytes32 payload)Call(string contract,string fn,string[] args)";
const CALL_TYPE: &str = "Call(string contract,string fn,string[] args)";

/// Order of the secp256k1 group.
const CURVE_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

#[derive(Deserialize)]
struct Fixture {
    vectors: StdVec<Vector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    name: String,
    network_id: String,
    owner: String,
    account: String,
    payload: String,
    calls: StdVec<Call>,
    digest: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Call {
    contract: String,
    #[serde(rename = "fn")]
    function: String,
    args_xdr: StdVec<String>,
    args_text: StdVec<String>,
}

type CheckResult = Result<(), Result<AccountError, InvokeError>>;

const BAD_SIGNATURE: CheckResult = Err(Ok(AccountError::BadSignature));
const BAD_RECOVERY_ID: CheckResult = Err(Ok(AccountError::BadRecoveryId));
const UNSUPPORTED_CONTEXT: CheckResult = Err(Ok(AccountError::UnsupportedContext));

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../../../fixtures/vectors.json")).unwrap()
}

fn vector(name: &str) -> Vector {
    fixture()
        .vectors
        .into_iter()
        .find(|v| v.name == name)
        .unwrap()
}

fn unhex<const N: usize>(text: &str) -> [u8; N] {
    hex::decode(text.trim_start_matches("0x"))
        .unwrap()
        .try_into()
        .unwrap()
}

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

/// An environment on the vector's network, with the account registered at
/// the vector's address for the vector's owner.
fn setup(v: &Vector) -> (Env, Address) {
    let env = Env::default();
    env.ledger().set_network_id(unhex(&v.network_id));
    let account = Address::from_str(&env, &v.account);
    let owner = BytesN::from_array(&env, &unhex::<20>(&v.owner));
    env.register_at(&account, PasoAccount, (owner,));
    (env, account)
}

fn decode_arg(env: &Env, base64_xdr: &str) -> Val {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(base64_xdr)
        .unwrap();
    let value = ScVal::from_xdr(raw, Limits::none()).unwrap();
    Val::try_from_val(env, &value).unwrap()
}

fn contexts(env: &Env, v: &Vector) -> Vec<Context> {
    let mut out = Vec::new(env);
    for call in &v.calls {
        let mut args = Vec::new(env);
        for arg in &call.args_xdr {
            args.push_back(decode_arg(env, arg));
        }
        out.push_back(Context::Contract(ContractContext {
            contract: Address::from_str(env, &call.contract),
            fn_name: Symbol::new(env, &call.function),
            args,
        }));
    }
    out
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

fn check_vector(v: &Vector) -> CheckResult {
    let (env, account) = setup(v);
    check(
        &env,
        &account,
        unhex(&v.payload),
        unhex(&v.signature),
        &contexts(&env, v),
    )
}

/// Ethereum address of a secp256k1 key.
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

/// `order - s`, the other valid `s` for the same signature.
fn mirrored_s(s: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut digit = CURVE_ORDER[i] as i16 - s[i] as i16 - borrow;
        borrow = 0;
        if digit < 0 {
            digit += 256;
            borrow = 1;
        }
        out[i] = digit as u8;
    }
    out
}

struct TextCall {
    contract: String,
    function: String,
    args: StdVec<String>,
}

/// EIP-712 digest computed without any contract code.
fn reference_digest(
    network_id: &[u8; 32],
    account: &str,
    calls: &[TextCall],
    payload: &[u8; 32],
) -> [u8; 32] {
    let mut call_hashes = StdVec::new();
    for call in calls {
        let mut arg_hashes = StdVec::new();
        for arg in &call.args {
            arg_hashes.extend_from_slice(&keccak(arg.as_bytes()));
        }
        let encoded = [
            keccak(CALL_TYPE.as_bytes()),
            keccak(call.contract.as_bytes()),
            keccak(call.function.as_bytes()),
            keccak(&arg_hashes),
        ]
        .concat();
        call_hashes.extend_from_slice(&keccak(&encoded));
    }

    let message = keccak(
        &[
            keccak(AUTHORIZATION_TYPE.as_bytes()),
            keccak(account.as_bytes()),
            keccak(&call_hashes),
            *payload,
        ]
        .concat(),
    );
    let domain = keccak(
        &[
            keccak(DOMAIN_TYPE.as_bytes()),
            keccak(b"Paso"),
            keccak(b"1"),
            *network_id,
        ]
        .concat(),
    );

    let mut preimage = std::vec![0x19, 0x01];
    preimage.extend_from_slice(&domain);
    preimage.extend_from_slice(&message);
    keccak(&preimage)
}

#[test]
fn constants_match_their_preimages() {
    assert_eq!(eip712::DOMAIN_TYPE_HASH, keccak(DOMAIN_TYPE.as_bytes()));
    assert_eq!(eip712::NAME_HASH, keccak(b"Paso"));
    assert_eq!(eip712::VERSION_HASH, keccak(b"1"));
    assert_eq!(
        eip712::AUTHORIZATION_TYPE_HASH,
        keccak(AUTHORIZATION_TYPE.as_bytes())
    );
    assert_eq!(eip712::CALL_TYPE_HASH, keccak(CALL_TYPE.as_bytes()));

    assert_eq!(crate::CURVE_ORDER, CURVE_ORDER);
    let mut doubled = [0u8; 32];
    let mut carry = 1u16;
    for i in (0..32).rev() {
        let sum = crate::HALF_CURVE_ORDER[i] as u16 * 2 + carry;
        doubled[i] = sum as u8;
        carry = sum >> 8;
    }
    assert_eq!(doubled, CURVE_ORDER);
}

#[test]
fn length_prefixed_values_sit_eight_bytes_into_their_xdr() {
    let env = Env::default();

    let symbols = [
        "",
        "a",
        "ok",
        "transfer",
        "nine_char",
        "ten_chars_",
        "set_label_with_a_32_char_fn_name",
    ];
    for text in symbols {
        let raw = std_bytes(&Symbol::new(&env, text).to_xdr(&env));
        assert_eq!(&raw[0..4], &15u32.to_be_bytes());
        assert_eq!(&raw[4..8], &(text.len() as u32).to_be_bytes());
        assert_eq!(&raw[8..8 + text.len()], text.as_bytes());
        assert_eq!(raw.len(), 8 + text.len().div_ceil(4) * 4);
    }

    let text = "Día de pago";
    let raw = std_bytes(&soroban_sdk::String::from_str(&env, text).to_xdr(&env));
    assert_eq!(&raw[0..4], &14u32.to_be_bytes());
    assert_eq!(&raw[4..8], &(text.len() as u32).to_be_bytes());
    assert_eq!(&raw[8..8 + text.len()], text.as_bytes());

    let data = [0xde, 0xad, 0xbe, 0xef, 0x01];
    let raw = std_bytes(&Bytes::from_array(&env, &data).to_xdr(&env));
    assert_eq!(&raw[0..4], &13u32.to_be_bytes());
    assert_eq!(&raw[4..8], &5u32.to_be_bytes());
    assert_eq!(&raw[8..13], &data);
    assert_eq!(raw.len(), 16);
}

#[test]
fn scalar_values_sit_four_bytes_into_their_xdr() {
    let env = Env::default();
    let xdr_of = |value: Val| std_bytes(&value.to_xdr(&env));

    assert_eq!(xdr_of(true.into_val(&env)), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert_eq!(xdr_of(false.into_val(&env)), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(xdr_of(().into_val(&env)), [0, 0, 0, 1]);
    assert_eq!(xdr_of(7u32.into_val(&env)), [0, 0, 0, 3, 0, 0, 0, 7]);
    assert_eq!(
        xdr_of((-1i32).into_val(&env)),
        [0, 0, 0, 4, 255, 255, 255, 255]
    );
    assert_eq!(xdr_of(7u64.into_val(&env))[..4], [0, 0, 0, 5]);
    assert_eq!(xdr_of(7i64.into_val(&env))[..4], [0, 0, 0, 6]);

    let big = xdr_of(0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10_u128.into_val(&env));
    assert_eq!(big[..4], [0, 0, 0, 9]);
    assert_eq!(
        big[4..],
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
    );
    assert_eq!(xdr_of((-2i128).into_val(&env))[..4], [0, 0, 0, 10]);
    assert_eq!(
        xdr_of((-2i128).into_val(&env))[4..],
        [[255u8; 15].as_slice(), &[254]].concat()
    );

    let contract = Address::from_str(
        &env,
        "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG",
    );
    assert_eq!(xdr_of(contract.to_val())[..8], [0, 0, 0, 18, 0, 0, 0, 1]);
    let classic = Address::from_str(
        &env,
        "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
    );
    assert_eq!(xdr_of(classic.to_val())[..8], [0, 0, 0, 18, 0, 0, 0, 0]);
}

#[test]
fn renders_every_vector() {
    let env = Env::default();
    let mut rendered = 0;
    for v in fixture().vectors {
        for call in &v.calls {
            assert_eq!(call.args_xdr.len(), call.args_text.len());
            for (arg, expected) in call.args_xdr.iter().zip(&call.args_text) {
                let text = render::text(&env, &decode_arg(&env, arg));
                assert_eq!(
                    String::from_utf8(std_bytes(&text)).unwrap(),
                    *expected,
                    "{}: {}",
                    v.name,
                    call.function
                );
                rendered += 1;
            }

            let contract = Address::from_str(&env, &call.contract);
            assert_eq!(
                std_bytes(&render::text(&env, contract.as_val())),
                call.contract.as_bytes()
            );
            let function = Symbol::new(&env, &call.function);
            assert_eq!(
                std_bytes(&render::text(&env, function.as_val())),
                call.function.as_bytes()
            );
        }
    }
    assert!(rendered > 60);
}

#[test]
fn renders_long_byte_strings() {
    let env = Env::default();
    for len in [63usize, 64, 65, 128, 300] {
        let data: StdVec<u8> = (0..len).map(|i| (i * 7 + 3) as u8).collect();
        let value = Bytes::from_slice(&env, &data);
        let text = render::text(&env, value.as_val());
        assert_eq!(
            String::from_utf8(std_bytes(&text)).unwrap(),
            std::format!("0x{}", hex::encode(&data))
        );
    }
}

#[test]
fn hashes_values_without_a_text_form() {
    let env = Env::default();
    let value: Val = vec![&env, 1u32, 2u32].into_val(&env);
    let scval = ScVal::try_from_val(&env, &value).unwrap();
    let expected = std::format!(
        "xdr:{}",
        hex::encode(Sha256::digest(
            WriteXdr::to_xdr(&scval, Limits::none()).unwrap()
        ))
    );
    assert_eq!(
        String::from_utf8(std_bytes(&render::text(&env, &value))).unwrap(),
        expected
    );
}

#[test]
fn digest_matches_every_vector() {
    for v in fixture().vectors {
        let (env, account) = setup(&v);
        let contexts = contexts(&env, &v);
        let payload = BytesN::from_array(&env, &unhex(&v.payload));
        let digest = env.as_contract(&account, || {
            eip712::digest(&env, &payload, &contexts)
                .unwrap()
                .to_array()
        });
        assert_eq!(
            hex::encode(digest),
            v.digest.trim_start_matches("0x"),
            "{}",
            v.name
        );

        let calls: StdVec<TextCall> = v
            .calls
            .iter()
            .map(|call| TextCall {
                contract: call.contract.clone(),
                function: call.function.clone(),
                args: call.args_text.clone(),
            })
            .collect();
        let reference = reference_digest(
            &unhex(&v.network_id),
            &v.account,
            &calls,
            &unhex(&v.payload),
        );
        assert_eq!(digest, reference, "{}", v.name);
    }
}

#[test]
fn accepts_every_vector() {
    let vectors = fixture().vectors;
    assert!(vectors.len() >= 8);
    for v in vectors {
        assert_eq!(check_vector(&v), Ok(()), "{}", v.name);
    }
}

#[test]
fn owner_is_stored() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let client = PasoAccountClient::new(&env, &account);
    assert_eq!(client.owner().to_array(), unhex::<20>(&v.owner));
}

#[test]
fn rejects_wrong_signer() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let stranger = SigningKey::from_slice(&[0x42; 32]).unwrap();
    let signature = sign(&stranger, &unhex(&v.digest));
    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            signature,
            &contexts(&env, &v)
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_signature_of_another_owner() {
    let v = vector("usdc_transfer");
    let other = vector("second_owner");
    let (env, account) = setup(&v);
    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            unhex(&other.signature),
            &contexts(&env, &v)
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_changed_argument() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);

    let Context::Contract(call) = contexts(&env, &v).get_unchecked(0) else {
        unreachable!()
    };
    let mut args = call.args.clone();
    assert_eq!(
        i128::try_from_val(&env, &args.get_unchecked(2)).unwrap(),
        10_000_000
    );
    args.set(2, 10_000_001i128.into_val(&env));
    let changed = vec![&env, Context::Contract(ContractContext { args, ..call })];

    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            unhex(&v.signature),
            &changed
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_changed_recipient() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);

    let Context::Contract(call) = contexts(&env, &v).get_unchecked(0) else {
        unreachable!()
    };
    let mut args = call.args.clone();
    args.set(1, Address::generate(&env).into_val(&env));
    let changed = vec![&env, Context::Contract(ContractContext { args, ..call })];

    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            unhex(&v.signature),
            &changed
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_changed_contract_or_function() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let Context::Contract(call) = contexts(&env, &v).get_unchecked(0) else {
        unreachable!()
    };

    let other_contract = vec![
        &env,
        Context::Contract(ContractContext {
            contract: Address::generate(&env),
            ..call.clone()
        }),
    ];
    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            unhex(&v.signature),
            &other_contract
        ),
        BAD_SIGNATURE
    );

    let other_function = vec![
        &env,
        Context::Contract(ContractContext {
            fn_name: Symbol::new(&env, "transfer_from"),
            ..call
        }),
    ];
    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            unhex(&v.signature),
            &other_function
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_added_call() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let mut extended = contexts(&env, &v);
    extended.push_back(extended.get_unchecked(0));
    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            unhex(&v.signature),
            &extended
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_removed_call() {
    let v = vector("exit_with_nested_transfer");
    let (env, account) = setup(&v);
    let mut shortened = contexts(&env, &v);
    shortened.pop_back_unchecked();
    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            unhex(&v.signature),
            &shortened
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_reordered_calls() {
    let v = vector("exit_with_nested_transfer");
    let (env, account) = setup(&v);
    let original = contexts(&env, &v);
    let swapped = vec![&env, original.get_unchecked(1), original.get_unchecked(0)];
    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            unhex(&v.signature),
            &swapped
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_other_account() {
    let v = vector("usdc_transfer");
    let (env, _) = setup(&v);
    let elsewhere = env.register(
        PasoAccount,
        (BytesN::from_array(&env, &unhex::<20>(&v.owner)),),
    );
    assert_eq!(
        check(
            &env,
            &elsewhere,
            unhex(&v.payload),
            unhex(&v.signature),
            &contexts(&env, &v)
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_other_network() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let mainnet = vector("usdc_transfer_on_mainnet");
    assert_ne!(v.network_id, mainnet.network_id);
    env.ledger().set_network_id(unhex(&mainnet.network_id));
    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            unhex(&v.signature),
            &contexts(&env, &v)
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_other_payload() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let mut payload: [u8; 32] = unhex(&v.payload);
    payload[31] ^= 1;
    assert_eq!(
        check(
            &env,
            &account,
            payload,
            unhex(&v.signature),
            &contexts(&env, &v)
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_create_contract_context() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let executable = ContractExecutable::Wasm(BytesN::from_array(&env, &[7; 32]));
    let salt = BytesN::from_array(&env, &[9; 32]);

    let create = Context::CreateContractHostFn(CreateContractHostFnContext {
        executable: executable.clone(),
        salt: salt.clone(),
    });
    let create_with_constructor =
        Context::CreateContractWithCtorHostFn(CreateContractWithConstructorHostFnContext {
            executable,
            salt,
            constructor_args: Vec::new(&env),
        });

    for context in [create, create_with_constructor] {
        let alone = vec![&env, context.clone()];
        assert_eq!(
            check(
                &env,
                &account,
                unhex(&v.payload),
                unhex(&v.signature),
                &alone
            ),
            UNSUPPORTED_CONTEXT
        );

        let mut after_a_call = contexts(&env, &v);
        after_a_call.push_back(context);
        assert_eq!(
            check(
                &env,
                &account,
                unhex(&v.payload),
                unhex(&v.signature),
                &after_a_call
            ),
            UNSUPPORTED_CONTEXT
        );
    }
}

#[test]
fn accepts_v_0_1_and_27_28() {
    let mut seen = [false; 2];
    for v in fixture().vectors {
        let (env, account) = setup(&v);
        let contexts = contexts(&env, &v);
        let mut signature: [u8; 65] = unhex(&v.signature);
        assert!(signature[64] == 27 || signature[64] == 28, "{}", v.name);
        let parity = signature[64] - 27;
        seen[parity as usize] = true;

        for recovery in [parity, parity + 27] {
            signature[64] = recovery;
            assert_eq!(
                check(&env, &account, unhex(&v.payload), signature, &contexts),
                Ok(()),
                "{} with v = {}",
                v.name,
                recovery
            );
        }
    }
    assert_eq!(seen, [true, true]);
}

#[test]
fn rejects_v_2() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let contexts = contexts(&env, &v);
    let mut signature: [u8; 65] = unhex(&v.signature);
    for recovery in [2, 3, 4, 26, 29, 35, 36, 255] {
        signature[64] = recovery;
        assert_eq!(
            check(&env, &account, unhex(&v.payload), signature, &contexts),
            BAD_RECOVERY_ID,
            "v = {}",
            recovery
        );
    }
}

#[test]
fn rejects_flipped_recovery_id() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let mut signature: [u8; 65] = unhex(&v.signature);
    signature[64] = if signature[64] == 27 { 28 } else { 27 };
    assert_eq!(
        check(
            &env,
            &account,
            unhex(&v.payload),
            signature,
            &contexts(&env, &v)
        ),
        BAD_SIGNATURE
    );
}

#[test]
fn rejects_high_s() {
    for v in fixture().vectors {
        let (env, account) = setup(&v);
        let mut signature: [u8; 65] = unhex(&v.signature);
        let mirrored = mirrored_s(&signature[32..64]);
        assert!(mirrored > crate::HALF_CURVE_ORDER);
        signature[32..64].copy_from_slice(&mirrored);
        signature[64] = if signature[64] == 27 { 28 } else { 27 };
        assert_eq!(
            check(
                &env,
                &account,
                unhex(&v.payload),
                signature,
                &contexts(&env, &v)
            ),
            BAD_SIGNATURE,
            "{}",
            v.name
        );
    }
}

#[test]
fn rejects_out_of_range_r_and_s() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let contexts = contexts(&env, &v);
    let good: [u8; 65] = unhex(&v.signature);

    let mut above_order = CURVE_ORDER;
    above_order[31] += 1;
    for scalar in [[0u8; 32], CURVE_ORDER, above_order, [0xff; 32]] {
        let mut bad_r = good;
        bad_r[..32].copy_from_slice(&scalar);
        assert_eq!(
            check(&env, &account, unhex(&v.payload), bad_r, &contexts),
            BAD_SIGNATURE
        );

        let mut bad_s = good;
        bad_s[32..64].copy_from_slice(&scalar);
        assert_eq!(
            check(&env, &account, unhex(&v.payload), bad_s, &contexts),
            BAD_SIGNATURE
        );
    }
}

#[test]
fn never_accepts_an_arbitrary_r() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let contexts = contexts(&env, &v);
    let mut signature: [u8; 65] = unhex(&v.signature);
    for r in 1..=24u8 {
        signature[..32].copy_from_slice(&[r; 32]);
        for recovery in [27, 28] {
            signature[64] = recovery;
            assert!(check(&env, &account, unhex(&v.payload), signature, &contexts).is_err());
        }
    }
}

#[test]
fn rejects_signature_of_the_wrong_length() {
    let v = vector("usdc_transfer");
    let (env, account) = setup(&v);
    let signature: [u8; 65] = unhex(&v.signature);
    let truncated: Val = Bytes::from_slice(&env, &signature[..64]).into_val(&env);
    let result = env.try_invoke_contract_check_auth::<AccountError>(
        &account,
        &BytesN::from_array(&env, &unhex(&v.payload)),
        truncated,
        &contexts(&env, &v),
    );
    assert!(result.is_err());
}

/// A contract whose calls all need the same address to authorise them. Four
/// instances are wired into the tree `root → [middle → [deep], last]`.
#[contract]
struct Node;

#[contractimpl]
impl Node {
    pub fn leaf(_env: Env, who: Address, _tag: u32) {
        who.require_auth();
    }

    pub fn middle(env: Env, who: Address, deep: Address) {
        who.require_auth();
        NodeClient::new(&env, &deep).leaf(&who, &1);
    }

    pub fn root(env: Env, who: Address, middle: Address, deep: Address, last: Address) {
        who.require_auth();
        NodeClient::new(&env, &middle).middle(&who, &deep);
        NodeClient::new(&env, &last).leaf(&who, &2);
    }
}

fn sc_address(address: &Address) -> ScAddress {
    ScAddress::from(address)
}

fn invocation(
    contract: &Address,
    function: &str,
    args: StdVec<ScVal>,
    sub_invocations: StdVec<SorobanAuthorizedInvocation>,
) -> SorobanAuthorizedInvocation {
    SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: sc_address(contract),
            function_name: function.try_into().unwrap(),
            args: args.try_into().unwrap(),
        }),
        sub_invocations: sub_invocations.try_into().unwrap(),
    }
}

/// Runs `root` through the host's own authorisation path with a signature
/// over `calls`, listed in the order given.
fn run_tree(order: [usize; 4]) -> bool {
    let env = Env::default();
    let network_id = [0x5a; 32];
    env.ledger().set_network_id(network_id);

    let key = SigningKey::from_slice(&[0x17; 32]).unwrap();
    let account = env.register(PasoAccount, (BytesN::from_array(&env, &eth_address(&key)),));
    let root = env.register(Node, ());
    let middle = env.register(Node, ());
    let deep = env.register(Node, ());
    let last = env.register(Node, ());

    let who = ScVal::Address(sc_address(&account));
    let address = |a: &Address| ScVal::Address(sc_address(a));
    let tree = invocation(
        &root,
        "root",
        std::vec![
            who.clone(),
            address(&middle),
            address(&deep),
            address(&last)
        ],
        std::vec![
            invocation(
                &middle,
                "middle",
                std::vec![who.clone(), address(&deep)],
                std::vec![invocation(
                    &deep,
                    "leaf",
                    std::vec![who.clone(), ScVal::U32(1)],
                    std::vec![]
                )],
            ),
            invocation(
                &last,
                "leaf",
                std::vec![who.clone(), ScVal::U32(2)],
                std::vec![]
            ),
        ],
    );

    let me = strkey(&account);
    let calls = [
        TextCall {
            contract: strkey(&root),
            function: "root".into(),
            args: std::vec![me.clone(), strkey(&middle), strkey(&deep), strkey(&last)],
        },
        TextCall {
            contract: strkey(&middle),
            function: "middle".into(),
            args: std::vec![me.clone(), strkey(&deep)],
        },
        TextCall {
            contract: strkey(&deep),
            function: "leaf".into(),
            args: std::vec![me.clone(), "1".into()],
        },
        TextCall {
            contract: strkey(&last),
            function: "leaf".into(),
            args: std::vec![me.clone(), "2".into()],
        },
    ];
    let mut slots: StdVec<Option<TextCall>> = calls.into_iter().map(Some).collect();
    let ordered: StdVec<TextCall> = order.iter().map(|i| slots[*i].take().unwrap()).collect();

    let nonce = 7;
    let signature_expiration_ledger = 1000;
    let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
        network_id: xdr::Hash(network_id),
        nonce,
        signature_expiration_ledger,
        invocation: tree.clone(),
    });
    let payload: [u8; 32] =
        Sha256::digest(WriteXdr::to_xdr(&preimage, Limits::none()).unwrap()).into();
    let signature = sign(
        &key,
        &reference_digest(&network_id, &me, &ordered, &payload),
    );

    env.set_auths(&[SorobanAuthorizationEntry {
        credentials: SorobanCredentials::Address(SorobanAddressCredentials {
            address: sc_address(&account),
            nonce,
            signature_expiration_ledger,
            signature: ScVal::Bytes(signature.to_vec().try_into().unwrap()),
        }),
        root_invocation: tree,
    }]);

    NodeClient::new(&env, &root)
        .try_root(&account, &middle, &deep, &last)
        .is_ok()
}

#[test]
fn host_lists_contexts_root_first_then_depth_first() {
    assert!(run_tree([0, 1, 2, 3]));

    assert!(!run_tree([0, 1, 3, 2]), "breadth first");
    assert!(!run_tree([2, 1, 3, 0]), "children before parents");
    assert!(!run_tree([0, 3, 1, 2]), "siblings in reverse");
}
