//! The verifier on its own: the vectors in `vectors/vectors.json` and every
//! way a signature can be wrong.
//!
//! Each check runs against two builds of the contract, the one compiled into
//! this test binary and the wasm from `stellar contract build`, and requires
//! the two to agree.

extern crate std;

use std::{string::String, vec::Vec as StdVec};

use k256::ecdsa::SigningKey;
use serde::Deserialize;
use sha3::{Digest, Keccak256};
use soroban_sdk::{
    testutils::Ledger as _, vec, xdr::ScErrorType, Address, Bytes, BytesN, Env, Error, IntoVal,
    InvokeError, Symbol, Val,
};

use crate::{
    eip712, EvmVerifier, EvmVerifierClient, EvmVerifierError, CURVE_ORDER, HALF_CURVE_ORDER,
};

pub(crate) const VERIFIER_WASM: &[u8] =
    include_bytes!("../../target/wasm32v1-none/release/paso_evm_verifier.wasm");

const DOMAIN_TYPE: &str = "EIP712Domain(string name,string version,bytes32 salt)";
const DOMAIN_NAME: &str = "Paso verifier";
const DOMAIN_VERSION: &str = "2";
const AUTHORIZATION_TYPE: &str = "Authorization(string account,bytes32 payload)";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Fixture {
    domain: Domain,
    domain_type: String,
    authorization_type: String,
    pub vectors: StdVec<Vector>,
    pub auth_payloads: StdVec<AuthPayloadVector>,
}

#[derive(Deserialize)]
struct Domain {
    name: String,
    version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Vector {
    pub name: String,
    pub network_id: String,
    pub signer: String,
    pub private_key: String,
    pub account: String,
    pub key_data: String,
    pub payload: String,
    pub open_zeppelin: Option<OpenZeppelin>,
    pub domain_separator: String,
    pub digest: String,
    pub signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenZeppelin {
    pub signature_payload: String,
    pub context_rule_ids: StdVec<u32>,
}

/// An account's signature value for one or more signers, as XDR.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthPayloadVector {
    pub name: String,
    pub verifier: String,
    pub account: String,
    pub context_rule_ids: StdVec<u32>,
    pub signers: StdVec<SignerSignature>,
    pub xdr: String,
}

#[derive(Deserialize)]
pub(crate) struct SignerSignature {
    pub address: String,
    pub signature: String,
}

/// What a call to `verify` came to: the boolean, or the error it failed with.
type Outcome = Result<bool, Result<Error, InvokeError>>;

const ACCEPTED: Outcome = Ok(true);
const REFUSED: Outcome = Ok(false);

fn failed(error: EvmVerifierError) -> Outcome {
    Err(Ok(error.into()))
}

pub(crate) fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../vectors/vectors.json")).unwrap()
}

pub(crate) fn vectors() -> StdVec<Vector> {
    fixture().vectors
}

fn vector(name: &str) -> Vector {
    vectors().into_iter().find(|v| v.name == name).unwrap()
}

pub(crate) fn unhex<const N: usize>(text: &str) -> [u8; N] {
    hex::decode(text.trim_start_matches("0x"))
        .unwrap()
        .try_into()
        .unwrap()
}

pub(crate) fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// Ethereum address of a secp256k1 key.
pub(crate) fn eth_address(key: &SigningKey) -> [u8; 20] {
    let point = key.verifying_key().to_encoded_point(false);
    keccak(&point.as_bytes()[1..])[12..].try_into().unwrap()
}

/// `r ‖ s ‖ v` over `digest`, in low-s form, with `v` 27 or 28.
pub(crate) fn sign(key: &SigningKey, digest: &[u8; 32]) -> [u8; 65] {
    let (signature, recovery_id) = key.sign_prehash_recoverable(digest).unwrap();
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&signature.to_bytes());
    out[64] = 27 + recovery_id.to_byte();
    out
}

/// Contract id behind a contract strkey (`C…`), decoded without the host.
pub(crate) fn contract_id(strkey: &str) -> [u8; 32] {
    stellar_strkey::Contract::from_string(strkey).unwrap().0
}

/// Strkey (`C…`) of a contract id, encoded without the host.
pub(crate) fn contract_strkey(id: &[u8; 32]) -> String {
    stellar_strkey::Contract(*id).to_string()
}

/// The key data of a signer: its address, then the contract id of its account.
pub(crate) fn key_data(address: &[u8; 20], account: &[u8; 32]) -> [u8; 52] {
    let mut out = [0u8; 52];
    out[..20].copy_from_slice(address);
    out[20..].copy_from_slice(account);
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

/// EIP-712 digest for any domain and message type, computed without any
/// contract code. `fields` are the encoded members of the message.
fn typed_digest(
    name: &str,
    version: &str,
    network_id: &[u8; 32],
    message_type: &str,
    fields: &[[u8; 32]],
) -> [u8; 32] {
    let domain = keccak(
        &[
            keccak(DOMAIN_TYPE.as_bytes()),
            keccak(name.as_bytes()),
            keccak(version.as_bytes()),
            *network_id,
        ]
        .concat(),
    );
    let mut message = keccak(message_type.as_bytes()).to_vec();
    message.extend_from_slice(&fields.concat());

    let mut preimage = std::vec![0x19, 0x01];
    preimage.extend_from_slice(&domain);
    preimage.extend_from_slice(&keccak(&message));
    keccak(&preimage)
}

fn reference_domain_separator(network_id: &[u8; 32]) -> [u8; 32] {
    keccak(
        &[
            keccak(DOMAIN_TYPE.as_bytes()),
            keccak(DOMAIN_NAME.as_bytes()),
            keccak(DOMAIN_VERSION.as_bytes()),
            *network_id,
        ]
        .concat(),
    )
}

/// The digest a signer of `account` (a strkey) signs over `payload`.
pub(crate) fn reference_digest(
    network_id: &[u8; 32],
    account: &str,
    payload: &[u8; 32],
) -> [u8; 32] {
    typed_digest(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        network_id,
        AUTHORIZATION_TYPE,
        &[keccak(account.as_bytes()), *payload],
    )
}

/// An environment on one network with both builds of the verifier.
struct Setup {
    env: Env,
    native: Address,
    wasm: Address,
}

fn setup(network_id: [u8; 32]) -> Setup {
    let env = Env::default();
    env.ledger().set_network_id(network_id);
    let native = env.register(EvmVerifier, ());
    let wasm = env.register(VERIFIER_WASM, ());
    Setup { env, native, wasm }
}

fn setup_for(v: &Vector) -> Setup {
    setup(unhex(&v.network_id))
}

impl Setup {
    /// Calls a function of both builds with raw byte strings and returns
    /// what they agree on.
    fn call<T>(&self, function: &str, args: &[&[u8]]) -> Result<T, Result<Error, InvokeError>>
    where
        T: soroban_sdk::TryFromVal<Env, Val> + PartialEq + core::fmt::Debug,
        T::Error: core::fmt::Debug,
    {
        let call = |verifier: &Address| {
            let mut values: soroban_sdk::Vec<Val> = vec![&self.env];
            for arg in args {
                values.push_back(Bytes::from_slice(&self.env, arg).into_val(&self.env));
            }
            self.env
                .try_invoke_contract::<T, Error>(
                    verifier,
                    &Symbol::new(&self.env, function),
                    values,
                )
                .map(|value| value.unwrap())
        };

        let native = call(&self.native);
        let wasm = call(&self.wasm);
        assert_eq!(native, wasm, "the two builds disagree");
        native
    }

    fn verify_raw(&self, payload: &[u8], key: &[u8], signature: &[u8]) -> Outcome {
        self.call("verify", &[payload, key, signature])
    }

    fn verify(&self, payload: &[u8; 32], key: &[u8; 52], signature: &[u8; 65]) -> Outcome {
        self.verify_raw(payload, key, signature)
    }

    fn verify_vector(&self, v: &Vector) -> Outcome {
        self.verify(
            &unhex(&v.payload),
            &unhex(&v.key_data),
            &unhex(&v.signature),
        )
    }
}

#[test]
fn constants_match_their_preimages() {
    let fixture = fixture();
    assert_eq!(fixture.domain_type, DOMAIN_TYPE);
    assert_eq!(fixture.authorization_type, AUTHORIZATION_TYPE);
    assert_eq!(fixture.domain.name, DOMAIN_NAME);
    assert_eq!(fixture.domain.version, DOMAIN_VERSION);

    assert_eq!(eip712::DOMAIN_TYPE_HASH, keccak(DOMAIN_TYPE.as_bytes()));
    assert_eq!(eip712::NAME_HASH, keccak(DOMAIN_NAME.as_bytes()));
    assert_eq!(eip712::VERSION_HASH, keccak(DOMAIN_VERSION.as_bytes()));
    assert_eq!(
        eip712::AUTHORIZATION_TYPE_HASH,
        keccak(AUTHORIZATION_TYPE.as_bytes())
    );
}

#[test]
fn half_curve_order_is_half_the_curve_order() {
    // 2 * half + 1 == order, in 256-bit big-endian arithmetic.
    let mut doubled = [0u8; 32];
    let mut carry = 1u16;
    for i in (0..32).rev() {
        let value = 2 * HALF_CURVE_ORDER[i] as u16 + carry;
        doubled[i] = value as u8;
        carry = value >> 8;
    }
    assert_eq!(carry, 0);
    assert_eq!(doubled, CURVE_ORDER);
}

#[test]
fn key_data_is_the_address_then_the_contract_id() {
    for v in vectors() {
        let id = contract_id(&v.account);
        assert_eq!(contract_strkey(&id), v.account, "{}", v.name);
        assert_eq!(
            key_data(&unhex(&v.signer), &id),
            unhex::<52>(&v.key_data),
            "{}",
            v.name
        );
    }
}

#[test]
fn account_is_rendered_as_its_strkey() {
    let s = setup([0; 32]);
    let mut ids: StdVec<[u8; 32]> = vectors().iter().map(|v| contract_id(&v.account)).collect();
    ids.extend([[0x00; 32], [0xff; 32], core::array::from_fn(|i| i as u8)]);
    for id in ids {
        let text = s.env.as_contract(&s.native, || {
            eip712::account_text(&s.env, &BytesN::from_array(&s.env, &id))
        });
        let text: StdVec<u8> = text.iter().collect();
        assert_eq!(String::from_utf8(text).unwrap(), contract_strkey(&id));
    }
}

#[test]
fn digest_matches_every_vector() {
    for v in vectors() {
        let network_id: [u8; 32] = unhex(&v.network_id);
        let payload: [u8; 32] = unhex(&v.payload);
        let expected: [u8; 32] = unhex(&v.digest);

        assert_eq!(
            reference_domain_separator(&network_id),
            unhex::<32>(&v.domain_separator),
            "{}",
            v.name
        );
        assert_eq!(
            reference_digest(&network_id, &v.account, &payload),
            expected,
            "{}",
            v.name
        );

        let s = setup_for(&v);
        let digest = s.env.as_contract(&s.native, || {
            eip712::digest(
                &s.env,
                &BytesN::from_array(&s.env, &contract_id(&v.account)),
                &BytesN::from_array(&s.env, &payload),
            )
            .to_array()
        });
        assert_eq!(digest, expected, "{}", v.name);
    }
}

#[test]
fn vectors_are_signed_by_their_keys() {
    for v in vectors() {
        let key = SigningKey::from_slice(&unhex::<32>(&v.private_key)).unwrap();
        assert_eq!(eth_address(&key), unhex::<20>(&v.signer), "{}", v.name);
        assert_eq!(
            sign(&key, &unhex(&v.digest)),
            unhex::<65>(&v.signature),
            "{}",
            v.name
        );
    }
}

#[test]
fn accepts_every_vector() {
    let vectors = vectors();
    assert_eq!(vectors.len(), 9);
    for v in vectors {
        assert_eq!(setup_for(&v).verify_vector(&v), ACCEPTED, "{}", v.name);
    }
}

#[test]
fn accepts_through_the_generated_client() {
    let v = vector("testnet");
    let s = setup_for(&v);
    for verifier in [&s.native, &s.wasm] {
        let client = EvmVerifierClient::new(&s.env, verifier);
        assert!(client.verify(
            &Bytes::from_array(&s.env, &unhex::<32>(&v.payload)),
            &Bytes::from_array(&s.env, &unhex::<52>(&v.key_data)),
            &BytesN::from_array(&s.env, &unhex(&v.signature)),
        ));
    }
}

#[test]
fn refuses_wrong_signer() {
    let v = vector("testnet");
    let other = vector("second_signer");
    assert_eq!(v.payload, other.payload);
    assert_eq!(v.account, other.account);
    assert_ne!(v.signer, other.signer);

    let s = setup_for(&v);
    let payload = unhex(&v.payload);
    // Each signature under the other signer's address.
    assert_eq!(
        s.verify(&payload, &unhex(&other.key_data), &unhex(&v.signature)),
        REFUSED
    );
    assert_eq!(
        s.verify(&payload, &unhex(&v.key_data), &unhex(&other.signature)),
        REFUSED
    );
    // And a key that appears in no vector.
    let stranger = SigningKey::from_slice(&[0x42; 32]).unwrap();
    let account = contract_id(&v.account);
    let signature = sign(&stranger, &unhex(&v.digest));
    assert_eq!(s.verify(&payload, &unhex(&v.key_data), &signature), REFUSED);
    assert_eq!(
        s.verify(
            &payload,
            &key_data(&eth_address(&stranger), &account),
            &signature
        ),
        ACCEPTED
    );
}

#[test]
fn refuses_another_account() {
    // The same key signs the same payload for two accounts. Neither
    // signature passes under key data that names the other account.
    let v = vector("testnet");
    let other = vector("another_account");
    assert_eq!(v.signer, other.signer);
    assert_eq!(v.payload, other.payload);
    assert_eq!(v.network_id, other.network_id);
    assert_ne!(v.account, other.account);
    assert_ne!(v.digest, other.digest);

    let s = setup_for(&v);
    let payload = unhex(&v.payload);
    assert_eq!(s.verify_vector(&v), ACCEPTED);
    assert_eq!(s.verify_vector(&other), ACCEPTED);
    assert_eq!(
        s.verify(&payload, &unhex(&other.key_data), &unhex(&v.signature)),
        REFUSED
    );
    assert_eq!(
        s.verify(&payload, &unhex(&v.key_data), &unhex(&other.signature)),
        REFUSED
    );

    // Any single flipped bit of the account id.
    let key: [u8; 52] = unhex(&v.key_data);
    for bit in 0..256 {
        let mut changed = key;
        changed[20 + bit / 8] ^= 1 << (bit % 8);
        assert_eq!(
            s.verify(&payload, &changed, &unhex(&v.signature)),
            REFUSED,
            "bit {bit}"
        );
    }
}

#[test]
fn refuses_wrong_payload() {
    let v = vector("testnet");
    let other = vector("another_payload");
    assert_eq!(v.signer, other.signer);
    assert_eq!(v.account, other.account);

    let s = setup_for(&v);
    let key = unhex(&v.key_data);
    let signature = unhex(&v.signature);
    assert_eq!(s.verify(&unhex(&other.payload), &key, &signature), REFUSED);

    // Any single flipped bit of the payload.
    let payload: [u8; 32] = unhex(&v.payload);
    for bit in 0..256 {
        let mut changed = payload;
        changed[bit / 8] ^= 1 << (bit % 8);
        assert_eq!(s.verify(&changed, &key, &signature), REFUSED, "bit {bit}");
    }
}

#[test]
fn refuses_wrong_network() {
    let testnet = vector("testnet");
    let mainnet = vector("mainnet");
    assert_eq!(testnet.key_data, mainnet.key_data);
    assert_eq!(testnet.payload, mainnet.payload);
    assert_ne!(testnet.network_id, mainnet.network_id);
    assert_ne!(testnet.digest, mainnet.digest);

    let on_testnet = setup_for(&testnet);
    assert_eq!(on_testnet.verify_vector(&testnet), ACCEPTED);
    assert_eq!(on_testnet.verify_vector(&mainnet), REFUSED);

    let on_mainnet = setup_for(&mainnet);
    assert_eq!(on_mainnet.verify_vector(&mainnet), ACCEPTED);
    assert_eq!(on_mainnet.verify_vector(&testnet), REFUSED);

    let elsewhere = setup([0x5a; 32]);
    assert_eq!(elsewhere.verify_vector(&testnet), REFUSED);
    assert_eq!(elsewhere.verify_vector(&mainnet), REFUSED);
}

#[test]
fn refuses_signatures_made_under_other_domains_and_message_types() {
    let v = vector("testnet");
    let key = SigningKey::from_slice(&unhex::<32>(&v.private_key)).unwrap();
    let network_id: [u8; 32] = unhex(&v.network_id);
    let payload: [u8; 32] = unhex(&v.payload);
    let account = keccak(v.account.as_bytes());
    let s = setup_for(&v);

    let own = typed_digest(
        DOMAIN_NAME,
        DOMAIN_VERSION,
        &network_id,
        AUTHORIZATION_TYPE,
        &[account, payload],
    );
    assert_eq!(own, unhex::<32>(&v.digest));

    let others = [
        // The domain name of Paso's own account.
        typed_digest(
            "Paso",
            DOMAIN_VERSION,
            &network_id,
            AUTHORIZATION_TYPE,
            &[account, payload],
        ),
        // Version 1 of this verifier, whose message named no account.
        typed_digest(
            DOMAIN_NAME,
            "1",
            &network_id,
            "Authorization(bytes32 payload)",
            &[payload],
        ),
        // The current message under the version 1 domain, and the reverse.
        typed_digest(
            DOMAIN_NAME,
            "1",
            &network_id,
            AUTHORIZATION_TYPE,
            &[account, payload],
        ),
        typed_digest(
            DOMAIN_NAME,
            DOMAIN_VERSION,
            &network_id,
            "Authorization(bytes32 payload)",
            &[payload],
        ),
        // The fields in the other order.
        typed_digest(
            DOMAIN_NAME,
            DOMAIN_VERSION,
            &network_id,
            "Authorization(bytes32 payload,string account)",
            &[payload, account],
        ),
        // No EIP-712 envelope: the payload signed as if it were the digest.
        payload,
    ];
    for digest in others {
        assert_ne!(digest, own);
        assert_eq!(
            s.verify(&payload, &unhex(&v.key_data), &sign(&key, &digest)),
            REFUSED
        );
    }
}

#[test]
fn accepts_v_0_1_and_27_28() {
    let mut seen = [false; 2];
    for v in vectors() {
        let s = setup_for(&v);
        let mut signature: [u8; 65] = unhex(&v.signature);
        assert!(signature[64] == 27 || signature[64] == 28, "{}", v.name);
        let parity = signature[64] - 27;
        seen[parity as usize] = true;

        for recovery in [parity, parity + 27] {
            signature[64] = recovery;
            assert_eq!(
                s.verify(&unhex(&v.payload), &unhex(&v.key_data), &signature),
                ACCEPTED,
                "{} with v = {}",
                v.name,
                recovery
            );
        }
    }
    assert_eq!(seen, [true, true]);
}

#[test]
fn rejects_v_out_of_range() {
    let v = vector("testnet");
    let s = setup_for(&v);
    let mut signature: [u8; 65] = unhex(&v.signature);
    for recovery in [2, 3, 4, 26, 29, 35, 36, 255] {
        signature[64] = recovery;
        assert_eq!(
            s.verify(&unhex(&v.payload), &unhex(&v.key_data), &signature),
            failed(EvmVerifierError::BadRecoveryId),
            "v = {recovery}"
        );
    }
}

#[test]
fn refuses_flipped_recovery_id() {
    for v in vectors() {
        let s = setup_for(&v);
        let mut signature: [u8; 65] = unhex(&v.signature);
        signature[64] = if signature[64] == 27 { 28 } else { 27 };
        assert_eq!(
            s.verify(&unhex(&v.payload), &unhex(&v.key_data), &signature),
            REFUSED,
            "{}",
            v.name
        );
    }
}

#[test]
fn rejects_high_s() {
    for v in vectors() {
        let s = setup_for(&v);
        let mut signature: [u8; 65] = unhex(&v.signature);
        assert!(signature[32..64] <= HALF_CURVE_ORDER[..], "{}", v.name);

        // The mirrored form, `order - s`, is the same signature to plain
        // ECDSA once the recovery id is flipped with it.
        let mirrored = mirrored_s(&signature[32..64]);
        assert!(mirrored > HALF_CURVE_ORDER);
        assert_eq!(mirrored_s(&mirrored), signature[32..64]);
        signature[32..64].copy_from_slice(&mirrored);

        for recovery in [27, 28] {
            signature[64] = recovery;
            assert_eq!(
                s.verify(&unhex(&v.payload), &unhex(&v.key_data), &signature),
                failed(EvmVerifierError::BadSignature),
                "{}",
                v.name
            );
        }
    }
}

#[test]
fn accepts_s_up_to_half_the_order_and_rejects_the_next() {
    // Not a signature anyone made: the point is which side of the limit is an
    // error and which side reaches the comparison.
    let v = vector("testnet");
    let s = setup_for(&v);
    let mut signature: [u8; 65] = unhex(&v.signature);

    signature[32..64].copy_from_slice(&HALF_CURVE_ORDER);
    assert_eq!(
        s.verify(&unhex(&v.payload), &unhex(&v.key_data), &signature),
        REFUSED
    );

    let mut above = HALF_CURVE_ORDER;
    above[31] += 1;
    signature[32..64].copy_from_slice(&above);
    assert_eq!(
        s.verify(&unhex(&v.payload), &unhex(&v.key_data), &signature),
        failed(EvmVerifierError::BadSignature)
    );
}

#[test]
fn rejects_zero_and_out_of_range_r_and_s() {
    let v = vector("testnet");
    let s = setup_for(&v);
    let payload = unhex(&v.payload);
    let key = unhex(&v.key_data);
    let good: [u8; 65] = unhex(&v.signature);

    let mut above_order = CURVE_ORDER;
    above_order[31] += 1;
    for scalar in [[0u8; 32], CURVE_ORDER, above_order, [0xff; 32]] {
        let mut bad_r = good;
        bad_r[..32].copy_from_slice(&scalar);
        assert_eq!(
            s.verify(&payload, &key, &bad_r),
            failed(EvmVerifierError::BadSignature)
        );

        let mut bad_s = good;
        bad_s[32..64].copy_from_slice(&scalar);
        assert_eq!(
            s.verify(&payload, &key, &bad_s),
            failed(EvmVerifierError::BadSignature)
        );
    }

    assert_eq!(
        s.verify(&payload, &key, &[0u8; 65]),
        failed(EvmVerifierError::BadSignature)
    );
}

#[test]
fn never_accepts_an_arbitrary_r() {
    // An `r` in range is either the x-coordinate of a curve point, and then
    // recovers some other key, or it is not, and then the host refuses it.
    let v = vector("testnet");
    let s = setup_for(&v);
    let mut signature: [u8; 65] = unhex(&v.signature);
    let mut refused = 0;
    let mut host_errors = 0;
    for r in 1..=24u8 {
        signature[..32].copy_from_slice(&[r; 32]);
        for recovery in [27, 28] {
            signature[64] = recovery;
            match s.verify(&unhex(&v.payload), &unhex(&v.key_data), &signature) {
                Ok(false) => refused += 1,
                Err(Ok(error)) if !error.is_type(ScErrorType::Contract) => host_errors += 1,
                other => panic!("r = {r:#04x} repeated, v = {recovery}: {other:?}"),
            }
        }
    }
    assert!(refused > 0 && host_errors > 0, "{refused} {host_errors}");
    assert_eq!(refused + host_errors, 48);
}

#[test]
fn rejects_payload_of_the_wrong_length() {
    let v = vector("testnet");
    let s = setup_for(&v);
    let payload: [u8; 32] = unhex(&v.payload);
    let key: [u8; 52] = unhex(&v.key_data);
    let signature: [u8; 65] = unhex(&v.signature);

    let mut longer = payload.to_vec();
    longer.push(0);
    for bad in [&payload[..31], &payload[..0], &longer[..]] {
        assert_eq!(
            s.verify_raw(bad, &key, &signature),
            failed(EvmVerifierError::BadPayloadLength)
        );
    }
}

#[test]
fn rejects_key_data_of_the_wrong_length() {
    let v = vector("testnet");
    let s = setup_for(&v);
    let payload: [u8; 32] = unhex(&v.payload);
    let key: [u8; 52] = unhex(&v.key_data);
    let signature: [u8; 65] = unhex(&v.signature);

    let mut longer = key.to_vec();
    longer.push(0);
    // Among them the bare address, and the account id with no address.
    for bad in [
        &key[..0],
        &key[..19],
        &key[..20],
        &key[20..],
        &key[..51],
        &longer[..],
    ] {
        assert_eq!(
            s.verify_raw(&payload, bad, &signature),
            failed(EvmVerifierError::BadKeyLength),
            "{} bytes",
            bad.len()
        );
    }
}

#[test]
fn rejects_signature_of_the_wrong_length() {
    let v = vector("testnet");
    let s = setup_for(&v);
    let payload: [u8; 32] = unhex(&v.payload);
    let key: [u8; 52] = unhex(&v.key_data);
    let signature: [u8; 65] = unhex(&v.signature);

    // 64 bytes is the compact form (EIP-2098), which is not accepted.
    let mut longer = signature.to_vec();
    longer.push(27);
    for bad in [&signature[..64], &longer[..], &[][..]] {
        assert!(s.verify_raw(&payload, &key, bad).is_err());
    }
}

#[test]
fn canonical_key_is_the_address_alone() {
    let v = vector("testnet");
    let same_address_elsewhere = vector("another_account");
    let other = vector("second_signer");
    let s = setup_for(&v);

    let canonical = |key_data: &str| -> StdVec<u8> {
        s.call::<Bytes>("canonicalize_key", &[&unhex::<52>(key_data)])
            .unwrap()
            .iter()
            .collect()
    };
    assert_eq!(canonical(&v.key_data), unhex::<20>(&v.signer));
    assert_eq!(canonical(&other.key_data), unhex::<20>(&other.signer));
    // One address under two account ids is one signer.
    assert_ne!(v.key_data, same_address_elsewhere.key_data);
    assert_eq!(
        canonical(&v.key_data),
        canonical(&same_address_elsewhere.key_data)
    );

    for verifier in [&s.native, &s.wasm] {
        let client = EvmVerifierClient::new(&s.env, verifier);
        let keys = vec![
            &s.env,
            Bytes::from_array(&s.env, &unhex::<52>(&other.key_data)),
            Bytes::from_array(&s.env, &unhex::<52>(&v.key_data)),
            Bytes::from_array(&s.env, &unhex::<52>(&same_address_elsewhere.key_data)),
        ];
        assert_eq!(
            client.batch_canonicalize_key(&keys),
            vec![
                &s.env,
                Bytes::from_array(&s.env, &unhex::<20>(&other.signer)),
                Bytes::from_array(&s.env, &unhex::<20>(&v.signer)),
                Bytes::from_array(&s.env, &unhex::<20>(&v.signer)),
            ]
        );
        assert_eq!(
            client.batch_canonicalize_key(&vec![&s.env]),
            soroban_sdk::Vec::<Bytes>::new(&s.env)
        );
    }
}

#[test]
fn canonical_key_of_the_wrong_length_is_an_error() {
    let s = setup([0; 32]);
    let good = [7u8; 52];
    for length in [0usize, 19, 20, 32, 51, 53] {
        let bad = std::vec![7u8; length];
        assert_eq!(
            s.call::<Bytes>("canonicalize_key", &[&bad]),
            Err(Ok(EvmVerifierError::BadKeyLength.into())),
            "{length} bytes"
        );

        for verifier in [&s.native, &s.wasm] {
            let keys = vec![
                &s.env,
                Bytes::from_array(&s.env, &good),
                Bytes::from_slice(&s.env, &bad),
            ];
            assert_eq!(
                EvmVerifierClient::new(&s.env, verifier).try_batch_canonicalize_key(&keys),
                Err(Ok(EvmVerifierError::BadKeyLength.into())),
                "{length} bytes"
            );
        }
    }
}
