extern crate std;

use std::{string::String, vec::Vec as StdVec};

use k256::ecdsa::SigningKey;
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use soroban_sdk::{
    contract, contractimpl, contracttype, map,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{
        self, HashIdPreimage, HashIdPreimageSorobanAuthorization,
        HashIdPreimageSorobanAuthorizationWithAddress, InvokeContractArgs, Limits, ScAddress,
        ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry, SorobanAuthorizedFunction,
        SorobanAuthorizedInvocation, SorobanCredentials, WriteXdr,
    },
    Address, Bytes, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

/// The verifier, from `stellar contract build`.
const VERIFIER_WASM: &[u8] =
    include_bytes!("../../target/wasm32v1-none/release/paso_evm_verifier.wasm");

/// OpenZeppelin's `multisig-account-example` as published on testnet and
/// mainnet, hash `1b5f4534…7785a`. `../evm` checks the hash.
const OZ_ACCOUNT_WASM: &[u8] =
    include_bytes!("../../evm/fixtures/openzeppelin/multisig_account_example.wasm");

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

// The two types of the account library that a caller has to build. The
// library itself, `stellar-accounts` 0.7.2, builds with soroban-sdk 26 and
// cannot be linked next to this host.

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Signer {
    Delegated(Address),
    External(Address, Bytes),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AuthPayload {
    pub signers: Map<Signer, Bytes>,
    pub context_rule_ids: Vec<u32>,
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

/// The two encodings of address credentials.
#[derive(Copy, Clone, Debug, PartialEq)]
enum Credentials {
    /// `SOROBAN_CREDENTIALS_ADDRESS`: the payload names no account.
    Legacy,
    /// `SOROBAN_CREDENTIALS_ADDRESS_V2`: the payload names the account.
    AddressBound,
}

const ENCODINGS: [Credentials; 2] = [Credentials::Legacy, Credentials::AddressBound];

fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// Ethereum address of a secp256k1 key.
fn eth_address(key: &SigningKey) -> [u8; 20] {
    let point = key.verifying_key().to_encoded_point(false);
    keccak(&point.as_bytes()[1..])[12..].try_into().unwrap()
}

fn ethereum_key(seed: u8) -> SigningKey {
    SigningKey::from_slice(&[seed; 32]).unwrap()
}

/// Contract id of a contract address.
fn id_of(address: &Address) -> [u8; 32] {
    match ScAddress::from(address) {
        ScAddress::Contract(xdr::ContractId(xdr::Hash(id))) => id,
        other => panic!("{other:?} is not a contract"),
    }
}

fn strkey_of(address: &Address) -> String {
    stellar_strkey::Contract(id_of(address)).to_string()
}

/// The EIP-712 digest a signer of `account` signs over `payload`, computed
/// without any contract code.
fn reference_digest(account: &Address, payload: &[u8; 32]) -> [u8; 32] {
    let domain = keccak(
        &[
            keccak(b"EIP712Domain(string name,string version,bytes32 salt)"),
            keccak(b"Paso verifier"),
            keccak(b"2"),
            NETWORK_ID,
        ]
        .concat(),
    );
    let message = keccak(
        &[
            keccak(b"Authorization(string account,bytes32 payload)"),
            keccak(strkey_of(account).as_bytes()),
            *payload,
        ]
        .concat(),
    );

    let mut preimage = std::vec![0x19, 0x01];
    preimage.extend_from_slice(&domain);
    preimage.extend_from_slice(&message);
    keccak(&preimage)
}

/// `r ‖ s ‖ v` by `key` over `payload`, made for `account`.
fn ethereum_signature(key: &SigningKey, account: &Address, payload: &[u8; 32]) -> StdVec<u8> {
    let (signature, recovery_id) = key
        .sign_prehash_recoverable(&reference_digest(account, payload))
        .unwrap();
    let mut out = signature.to_bytes().to_vec();
    out.push(27 + recovery_id.to_byte());
    out
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

/// The payload the host derives from an entry of `account` and passes to its
/// `__check_auth`.
fn soroban_payload(
    credentials: Credentials,
    account: &Address,
    nonce: i64,
    invocation: &SorobanAuthorizedInvocation,
) -> [u8; 32] {
    let preimage = match credentials {
        Credentials::Legacy => {
            HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
                network_id: xdr::Hash(NETWORK_ID),
                nonce,
                signature_expiration_ledger: EXPIRATION_LEDGER,
                invocation: invocation.clone(),
            })
        }
        Credentials::AddressBound => HashIdPreimage::SorobanAuthorizationWithAddress(
            HashIdPreimageSorobanAuthorizationWithAddress {
                network_id: xdr::Hash(NETWORK_ID),
                nonce,
                signature_expiration_ledger: EXPIRATION_LEDGER,
                address: ScAddress::from(account),
                invocation: invocation.clone(),
            },
        ),
    };
    Sha256::digest(preimage.to_xdr(Limits::none()).unwrap()).into()
}

/// The 32 bytes a `stellar-accounts` 0.7.2 account hands to its verifiers for
/// one call under the default rule: sha256 of the Soroban payload followed
/// by the XDR of the rule ids.
fn verifier_payload(
    credentials: Credentials,
    account: &Address,
    nonce: i64,
    invocation: &SorobanAuthorizedInvocation,
) -> [u8; 32] {
    let ids = ScVal::Vec(Some(xdr::ScVec(
        std::vec![ScVal::U32(DEFAULT_RULE)].try_into().unwrap(),
    )));
    let mut preimage = soroban_payload(credentials, account, nonce, invocation).to_vec();
    preimage.extend_from_slice(&ids.to_xdr(Limits::none()).unwrap());
    Sha256::digest(preimage).into()
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
        let mut key_data = eth_address(key).to_vec();
        key_data.extend_from_slice(&id_of(account));
        Signer::External(
            self.verifier.clone(),
            Bytes::from_slice(&self.env, &key_data),
        )
    }

    /// Deploys the published account with the Ethereum key as its only
    /// signer and gives it [`BALANCE`] tokens.
    fn account_of(&self, key: &SigningKey) -> (Address, Signer) {
        let account = Address::generate(&self.env);
        let signer = self.ethereum_signer(key, &account);
        let policies: Map<Address, Val> = map![&self.env];
        self.env.register_at(
            &account,
            OZ_ACCOUNT_WASM,
            (vec![&self.env, signer.clone()], policies),
        );
        self.env.mock_all_auths();
        StellarAssetClient::new(&self.env, &self.token).mint(&account, &BALANCE);
        // Nothing is authorised from here on unless a test sets an entry.
        self.env.set_auths(&[]);
        (account, signer)
    }

    fn sc_val(&self, value: impl IntoVal<Env, Val>) -> ScVal {
        let value: Val = value.into_val(&self.env);
        ScVal::try_from_val(&self.env, &value).unwrap()
    }

    fn balance(&self, of: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(of)
    }

    /// An authorisation entry of `account` carrying one signature.
    fn entry(
        &self,
        credentials: Credentials,
        account: &Address,
        nonce: i64,
        invocation: &SorobanAuthorizedInvocation,
        signer: &Signer,
        signature: &[u8],
    ) -> SorobanAuthorizationEntry {
        let address_credentials = SorobanAddressCredentials {
            address: ScAddress::from(account),
            nonce,
            signature_expiration_ledger: EXPIRATION_LEDGER,
            signature: self.sc_val(AuthPayload {
                signers: map![
                    &self.env,
                    (signer.clone(), Bytes::from_slice(&self.env, signature))
                ],
                context_rule_ids: vec![&self.env, DEFAULT_RULE],
            }),
        };
        SorobanAuthorizationEntry {
            credentials: match credentials {
                Credentials::Legacy => SorobanCredentials::Address(address_credentials),
                Credentials::AddressBound => SorobanCredentials::AddressV2(address_credentials),
            },
            root_invocation: invocation.clone(),
        }
    }

    /// `token.transfer(account, recipient, AMOUNT)` as the tree an entry
    /// authorises.
    fn transfer_invocation(&self, account: &Address) -> SorobanAuthorizedInvocation {
        invocation(
            &self.token,
            "transfer",
            std::vec![
                self.sc_val(account),
                self.sc_val(&self.recipient),
                self.sc_val(AMOUNT),
            ],
        )
    }

    /// Sets the one entry of the transaction and attempts the transfer.
    fn transfer(&self, account: &Address, entry: SorobanAuthorizationEntry) -> bool {
        self.env.set_auths(&[entry]);
        TokenClient::new(&self.env, &self.token)
            .try_transfer(account, &self.recipient, &AMOUNT)
            .is_ok()
    }
}

#[test]
fn ethereum_signer_authorises_a_transfer_under_either_encoding() {
    for credentials in ENCODINGS {
        let w = world();
        let key = ethereum_key(0x17);
        let (account, signer) = w.account_of(&key);
        let transfer = w.transfer_invocation(&account);
        let payload = verifier_payload(credentials, &account, 7, &transfer);

        // Another key, then the right key over the other encoding's payload.
        let forged = ethereum_signature(&ethereum_key(0x42), &account, &payload);
        let entry = w.entry(credentials, &account, 7, &transfer, &signer, &forged);
        assert!(!w.transfer(&account, entry), "{credentials:?}");
        for other in ENCODINGS {
            if other == credentials {
                continue;
            }
            let other_payload = verifier_payload(other, &account, 7, &transfer);
            assert_ne!(other_payload, payload);
            let signature = ethereum_signature(&key, &account, &other_payload);
            let entry = w.entry(credentials, &account, 7, &transfer, &signer, &signature);
            assert!(!w.transfer(&account, entry), "{credentials:?}");
        }
        assert_eq!(w.balance(&account), BALANCE);

        let signature = ethereum_signature(&key, &account, &payload);
        let entry = w.entry(credentials, &account, 7, &transfer, &signer, &signature);
        assert!(w.transfer(&account, entry), "{credentials:?}");
        assert_eq!(w.balance(&account), BALANCE - AMOUNT);
        assert_eq!(w.balance(&w.recipient), AMOUNT);
    }
}

#[test]
fn signature_for_one_account_fails_on_another_that_lists_the_same_address() {
    // Two accounts list the same Ethereum address and are asked to authorise
    // the same call under the same nonce.
    for credentials in ENCODINGS {
        let w = world();
        let key = ethereum_key(0x17);
        let (first, first_signer) = w.account_of(&key);
        let (second, second_signer) = w.account_of(&key);
        let gate = w.env.register(Gate, ());
        let opening = invocation(
            &gate,
            "open",
            std::vec![w.sc_val(&first), w.sc_val(&second)],
        );

        let first_payload = verifier_payload(credentials, &first, 7, &opening);
        let second_payload = verifier_payload(credentials, &second, 7, &opening);
        // The legacy payload is the same 32 bytes for both accounts. The
        // address-bound one already differs.
        assert_eq!(
            first_payload == second_payload,
            credentials == Credentials::Legacy
        );

        let open = |first_signature: &[u8], second_signature: &[u8]| {
            w.env.set_auths(&[
                w.entry(
                    credentials,
                    &first,
                    7,
                    &opening,
                    &first_signer,
                    first_signature,
                ),
                w.entry(
                    credentials,
                    &second,
                    7,
                    &opening,
                    &second_signer,
                    second_signature,
                ),
            ]);
            w.env
                .try_invoke_contract::<(), soroban_sdk::Error>(
                    &gate,
                    &Symbol::new(&w.env, "open"),
                    vec![&w.env, first.into_val(&w.env), second.into_val(&w.env)],
                )
                .is_ok()
        };

        let for_first = ethereum_signature(&key, &first, &first_payload);
        let for_second = ethereum_signature(&key, &second, &second_payload);

        // The first account's signature, presented for the second account.
        assert!(!open(&for_first, &for_first), "{credentials:?}");
        // The second account's own payload, signed for the first account:
        // only the account in the message is wrong.
        let wrong_account = ethereum_signature(&key, &first, &second_payload);
        assert!(!open(&for_first, &wrong_account), "{credentials:?}");

        assert!(open(&for_first, &for_second), "{credentials:?}");
    }
}
