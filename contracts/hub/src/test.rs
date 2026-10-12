extern crate std;

use std::{string::String, vec::Vec as StdVec};

use k256::ecdsa::SigningKey;
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    xdr::{
        self, ContractIdPreimage, ContractIdPreimageFromAddress, HashIdPreimage,
        HashIdPreimageContractId, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits,
        ScAddress, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
        SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, WriteXdr,
    },
    Address, BytesN, Env, Event as _, IntoVal, Symbol,
};

use crate::{Exit, HubError, PasoHub, PasoHubClient};

mod account {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/paso_account.wasm");
}

const NETWORK_ID: [u8; 32] = [0x5a; 32];
const BASE_DOMAIN: u32 = 6;
const FAST_FINALITY: u32 = 1000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Burn {
    pub caller: Address,
    pub amount: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub burn_token: Address,
    pub destination_caller: BytesN<32>,
    pub max_fee: i128,
    pub min_finality_threshold: u32,
}

/// Stands in for Circle's TokenMessengerMinter: takes the approved tokens
/// from the caller, burns them and remembers what it was asked to do.
#[contract]
struct MockTokenMessenger;

#[contractimpl]
impl MockTokenMessenger {
    #[allow(clippy::too_many_arguments)]
    pub fn deposit_for_burn(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    ) {
        caller.require_auth();

        let this = env.current_contract_address();
        let token = TokenClient::new(&env, &burn_token);
        token.transfer_from(&this, &caller, &this, &amount);
        token.burn(&this, &amount);

        env.storage().instance().set(
            &symbol_short!("burn"),
            &Burn {
                caller,
                amount,
                destination_domain,
                mint_recipient,
                burn_token,
                destination_caller,
                max_fee,
                min_finality_threshold,
            },
        );
    }

    pub fn last_burn(env: Env) -> Option<Burn> {
        env.storage().instance().get(&symbol_short!("burn"))
    }
}

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
        let messenger = env.register(MockTokenMessenger, ());
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

    fn messenger(&self) -> MockTokenMessengerClient<'_> {
        MockTokenMessengerClient::new(&self.env, &self.messenger)
    }

    /// Mints USDC to `to`, then goes back to enforcing authorisation.
    fn fund(&self, to: &Address, amount: i128) {
        self.env.mock_all_auths();
        StellarAssetClient::new(&self.env, &self.usdc).mint(to, &amount);
        self.env.set_auths(&[]);
    }

    fn owner(&self, byte: u8) -> BytesN<20> {
        BytesN::from_array(&self.env, &[byte; 20])
    }

    fn recipient(&self) -> BytesN<32> {
        let mut padded = [0u8; 32];
        padded[12..].copy_from_slice(&[0xab; 20]);
        BytesN::from_array(&self.env, &padded)
    }
}

fn strkey(address: &Address) -> String {
    let text = address.to_string();
    let mut out = std::vec![0u8; text.len() as usize];
    text.copy_into_slice(&mut out);
    String::from_utf8(out).unwrap()
}

#[test]
fn address_is_deterministic() {
    let world = World::new();
    let hub = world.hub();
    let owner = world.owner(0x11);

    let predicted = hub.address_of(&owner);
    assert_eq!(hub.address_of(&owner), predicted);
    assert_ne!(hub.address_of(&world.owner(0x12)), predicted);

    assert!(!predicted.exists());
    assert_eq!(hub.deploy(&owner), predicted);
    assert!(predicted.exists());
    assert_eq!(hub.address_of(&owner), predicted);
}

#[test]
fn address_matches_the_off_chain_derivation() {
    let world = World::new();
    let owner = [0x7c; 20];

    let mut salt = [0u8; 32];
    salt[12..].copy_from_slice(&owner);
    let preimage = HashIdPreimage::ContractId(HashIdPreimageContractId {
        network_id: xdr::Hash(NETWORK_ID),
        contract_id_preimage: ContractIdPreimage::Address(ContractIdPreimageFromAddress {
            address: ScAddress::from(&world.hub),
            salt: xdr::Uint256(salt),
        }),
    });
    let contract_id: [u8; 32] = Sha256::digest(preimage.to_xdr(Limits::none()).unwrap()).into();
    let derived: Address =
        ScAddress::Contract(xdr::ContractId(xdr::Hash(contract_id))).into_val(&world.env);

    let owner = BytesN::from_array(&world.env, &owner);
    assert_eq!(world.hub().address_of(&owner), derived);
    assert_eq!(world.hub().deploy(&owner), derived);
}

#[test]
fn address_depends_on_the_hub() {
    let first = World::new();
    let second = World::new();
    let other_hub = second.env.register(
        PasoHub,
        (
            second.env.deployer().upload_contract_wasm(account::WASM),
            second.usdc.clone(),
            second.messenger.clone(),
        ),
    );
    assert_ne!(strkey(&second.hub), strkey(&other_hub));

    let owner = second.owner(0x11);
    assert_ne!(
        second.hub().address_of(&owner),
        PasoHubClient::new(&second.env, &other_hub).address_of(&owner)
    );
    assert_eq!(
        strkey(&first.hub().address_of(&first.owner(0x11))),
        strkey(&second.hub().address_of(&owner))
    );
}

#[test]
fn deploy_is_idempotent() {
    let world = World::new();
    let hub = world.hub();
    let owner = world.owner(0x22);

    let first = hub.deploy(&owner);
    let second = hub.deploy(&owner);
    let third = hub.deploy(&owner);
    assert_eq!(first, second);
    assert_eq!(first, third);
    assert_eq!(account::Client::new(&world.env, &first).owner(), owner);
}

#[test]
fn deploy_needs_no_authorization() {
    let world = World::new();
    world.env.set_auths(&[]);
    let twin = world.hub().deploy(&world.owner(0x33));
    assert!(twin.exists());
    assert_eq!(world.env.auths(), []);
}

#[test]
fn deployed_account_has_owner() {
    let world = World::new();
    let hub = world.hub();
    let (alice, bob) = (world.owner(0xa1), world.owner(0xb0));

    let alices = hub.deploy(&alice);
    let bobs = hub.deploy(&bob);
    assert_ne!(alices, bobs);
    assert_eq!(account::Client::new(&world.env, &alices).owner(), alice);
    assert_eq!(account::Client::new(&world.env, &bobs).owner(), bob);
}

#[test]
fn receives_before_it_is_deployed() {
    let world = World::new();
    let owner = world.owner(0x44);
    let twin = world.hub().address_of(&owner);

    world.fund(&twin, 30_000_000);
    assert!(!twin.exists());
    assert_eq!(world.usdc().balance(&twin), 30_000_000);

    assert_eq!(world.hub().deploy(&owner), twin);
    assert_eq!(world.usdc().balance(&twin), 30_000_000);
}

#[test]
fn exit_requires_auth() {
    let world = World::new();
    let from = Address::generate(&world.env);
    world.fund(&from, 50_000_000);
    let recipient = world.recipient();

    let refused = world.hub().try_exit(
        &from,
        &20_000_000,
        &BASE_DOMAIN,
        &recipient,
        &1_000,
        &FAST_FINALITY,
    );
    assert!(refused.is_err());
    assert_eq!(world.usdc().balance(&from), 50_000_000);
    assert_eq!(world.messenger().last_burn(), None);

    world.env.mock_all_auths();
    world.hub().exit(
        &from,
        &20_000_000,
        &BASE_DOMAIN,
        &recipient,
        &1_000,
        &FAST_FINALITY,
    );
    assert_eq!(
        world.env.auths(),
        std::vec![(
            from.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    world.hub.clone(),
                    Symbol::new(&world.env, "exit"),
                    (
                        from.clone(),
                        20_000_000i128,
                        BASE_DOMAIN,
                        recipient.clone(),
                        1_000i128,
                        FAST_FINALITY
                    )
                        .into_val(&world.env),
                )),
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        world.usdc.clone(),
                        Symbol::new(&world.env, "transfer"),
                        (from.clone(), world.hub.clone(), 20_000_000i128).into_val(&world.env),
                    )),
                    sub_invocations: std::vec![],
                }],
            }
        )]
    );
}

#[test]
fn exit_pulls_and_burns() {
    let world = World::new();
    let from = Address::generate(&world.env);
    world.fund(&from, 50_000_000);
    let recipient = world.recipient();

    world.env.mock_all_auths();
    world.hub().exit(
        &from,
        &20_000_000,
        &BASE_DOMAIN,
        &recipient,
        &1_000,
        &FAST_FINALITY,
    );

    assert_eq!(
        world
            .env
            .events()
            .all()
            .filter_by_contract(&world.hub)
            .events(),
        [Exit {
            from: from.clone(),
            amount: 20_000_000,
            destination_domain: BASE_DOMAIN,
            recipient: recipient.clone(),
        }
        .to_xdr(&world.env, &world.hub)]
    );

    assert_eq!(world.usdc().balance(&from), 30_000_000);
    assert_eq!(world.usdc().balance(&world.hub), 0);
    assert_eq!(world.usdc().balance(&world.messenger), 0);
    assert_eq!(world.usdc().allowance(&world.hub, &world.messenger), 0);

    assert_eq!(
        world.messenger().last_burn(),
        Some(Burn {
            caller: world.hub.clone(),
            amount: 20_000_000,
            destination_domain: BASE_DOMAIN,
            mint_recipient: recipient,
            burn_token: world.usdc.clone(),
            destination_caller: BytesN::from_array(&world.env, &[0; 32]),
            max_fee: 1_000,
            min_finality_threshold: FAST_FINALITY,
        })
    );
}

#[test]
fn exit_rejects_non_positive_amount() {
    let world = World::new();
    let from = Address::generate(&world.env);
    world.fund(&from, 50_000_000);
    world.env.mock_all_auths();

    let cases = [
        (0, 0),
        (-10, 0),
        (-20_000_000, 0),
        (i128::MIN, 0),
        (i64::MAX as i128 + 1, 0),
        (i128::MAX, 0),
        (20_000_000, -10),
        (20_000_000, -1),
        (20_000_000, i128::MAX),
    ];
    for (amount, max_fee) in cases {
        assert_eq!(
            world.hub().try_exit(
                &from,
                &amount,
                &BASE_DOMAIN,
                &world.recipient(),
                &max_fee,
                &FAST_FINALITY
            ),
            Err(Ok(HubError::BadAmount.into())),
            "amount = {amount}, max_fee = {max_fee}"
        );
    }
    assert_eq!(world.usdc().balance(&from), 50_000_000);
    assert_eq!(world.messenger().last_burn(), None);
}

#[test]
fn exit_rejects_dust() {
    let world = World::new();
    let from = Address::generate(&world.env);
    world.fund(&from, 50_000_000);
    world.env.mock_all_auths();

    let cases = [
        (20_000_001, 1_000),
        (20_000_009, 1_000),
        (5, 0),
        (20_000_000, 1_001),
        (20_000_000, 9),
        (i64::MAX as i128, 0),
    ];
    for (amount, max_fee) in cases {
        assert_eq!(
            world.hub().try_exit(
                &from,
                &amount,
                &BASE_DOMAIN,
                &world.recipient(),
                &max_fee,
                &FAST_FINALITY
            ),
            Err(Ok(HubError::Dust.into())),
            "amount = {amount}, max_fee = {max_fee}"
        );
    }
    assert_eq!(world.usdc().balance(&from), 50_000_000);
    assert_eq!(world.messenger().last_burn(), None);

    world.hub().exit(
        &from,
        &10,
        &BASE_DOMAIN,
        &world.recipient(),
        &0,
        &FAST_FINALITY,
    );
    assert_eq!(world.usdc().balance(&from), 49_999_990);
}

#[test]
fn exit_fails_without_enough_usdc() {
    let world = World::new();
    let from = Address::generate(&world.env);
    world.fund(&from, 10_000_000);
    world.env.mock_all_auths();

    let result = world.hub().try_exit(
        &from,
        &20_000_000,
        &BASE_DOMAIN,
        &world.recipient(),
        &1_000,
        &FAST_FINALITY,
    );
    assert!(result.is_err());
    assert_eq!(world.usdc().balance(&from), 10_000_000);
    assert_eq!(world.messenger().last_burn(), None);
}

fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// EIP-712 digest of an authorisation, computed without any contract code.
fn reference_digest(
    account: &str,
    calls: &[(&str, &str, StdVec<String>)],
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

struct ExitRequest {
    amount: i128,
    max_fee: i128,
}

/// A deployed twin holding USDC, and the key of its owner.
struct Twin {
    world: World,
    key: SigningKey,
    address: Address,
}

impl Twin {
    fn new() -> Self {
        let world = World::new();
        let key = SigningKey::from_slice(&[0x17; 32]).unwrap();
        let public_key = key.verifying_key().to_encoded_point(false);
        let owner: [u8; 20] = keccak(&public_key.as_bytes()[1..])[12..]
            .try_into()
            .unwrap();

        let address = world.hub().deploy(&BytesN::from_array(&world.env, &owner));
        world.fund(&address, 50_000_000);
        Twin {
            world,
            key,
            address,
        }
    }

    /// An authorisation entry for `executed`, signed by the owner over the
    /// text of `shown`.
    fn authorize(&self, executed: &ExitRequest, shown: &ExitRequest) -> SorobanAuthorizationEntry {
        let world = &self.world;
        let twin = ScVal::Address(ScAddress::from(&self.address));
        let hub = ScVal::Address(ScAddress::from(&world.hub));
        let recipient = world.recipient();
        let amount = ScVal::from(executed.amount);

        let invocation = SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::from(&world.hub),
                function_name: "exit".try_into().unwrap(),
                args: std::vec![
                    twin.clone(),
                    amount.clone(),
                    ScVal::U32(BASE_DOMAIN),
                    ScVal::Bytes(recipient.to_array().to_vec().try_into().unwrap()),
                    ScVal::from(executed.max_fee),
                    ScVal::U32(FAST_FINALITY),
                ]
                .try_into()
                .unwrap(),
            }),
            sub_invocations: std::vec![SorobanAuthorizedInvocation {
                function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                    contract_address: ScAddress::from(&world.usdc),
                    function_name: "transfer".try_into().unwrap(),
                    args: std::vec![twin, hub, amount].try_into().unwrap(),
                }),
                sub_invocations: Default::default(),
            }]
            .try_into()
            .unwrap(),
        };

        let nonce = 1;
        let signature_expiration_ledger = 100;
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(NETWORK_ID),
            nonce,
            signature_expiration_ledger,
            invocation: invocation.clone(),
        });
        let payload: [u8; 32] = Sha256::digest(preimage.to_xdr(Limits::none()).unwrap()).into();

        let me = strkey(&self.address);
        let calls = [
            (
                strkey(&world.hub),
                "exit",
                std::vec![
                    me.clone(),
                    std::format!("{}", shown.amount),
                    "6".into(),
                    std::format!("0x{}{}", "00".repeat(12), "ab".repeat(20)),
                    std::format!("{}", shown.max_fee),
                    "1000".into(),
                ],
            ),
            (
                strkey(&world.usdc),
                "transfer",
                std::vec![
                    me.clone(),
                    strkey(&world.hub),
                    std::format!("{}", shown.amount)
                ],
            ),
        ];
        let calls: StdVec<(&str, &str, StdVec<String>)> = calls
            .iter()
            .map(|(contract, function, args)| (contract.as_str(), *function, args.clone()))
            .collect();
        let digest = reference_digest(&me, &calls, &payload);

        let (signature, recovery_id) = self.key.sign_prehash_recoverable(&digest).unwrap();
        let mut signature = signature.to_bytes().to_vec();
        signature.push(27 + recovery_id.to_byte());

        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(&self.address),
                nonce,
                signature_expiration_ledger,
                signature: ScVal::Bytes(signature.try_into().unwrap()),
            }),
            root_invocation: invocation,
        }
    }

    fn exit(&self, request: &ExitRequest) -> bool {
        self.world
            .hub()
            .try_exit(
                &self.address,
                &request.amount,
                &BASE_DOMAIN,
                &self.world.recipient(),
                &request.max_fee,
                &FAST_FINALITY,
            )
            .is_ok()
    }
}

#[test]
fn twin_exits_with_one_ethereum_signature() {
    let twin = Twin::new();
    let request = ExitRequest {
        amount: 20_000_000,
        max_fee: 1_000,
    };

    twin.world
        .env
        .set_auths(&[twin.authorize(&request, &request)]);
    assert!(twin.exit(&request));

    let world = &twin.world;
    assert_eq!(world.usdc().balance(&twin.address), 30_000_000);
    assert_eq!(world.usdc().balance(&world.hub), 0);
    let burn = world.messenger().last_burn().unwrap();
    assert_eq!(burn.caller, world.hub);
    assert_eq!(burn.amount, 20_000_000);
    assert_eq!(burn.mint_recipient, world.recipient());
}

#[test]
fn twin_refuses_an_exit_that_differs_from_what_was_shown() {
    let twin = Twin::new();
    let executed = ExitRequest {
        amount: 20_000_000,
        max_fee: 1_000,
    };
    let shown = ExitRequest {
        amount: 2_000_000,
        max_fee: 1_000,
    };

    twin.world
        .env
        .set_auths(&[twin.authorize(&executed, &shown)]);
    assert!(!twin.exit(&executed));
    assert_eq!(twin.world.usdc().balance(&twin.address), 50_000_000);
    assert_eq!(twin.world.messenger().last_burn(), None);
}

#[test]
fn twin_signature_cannot_be_replayed_or_stretched() {
    let twin = Twin::new();
    let signed = ExitRequest {
        amount: 20_000_000,
        max_fee: 1_000,
    };
    let entries = [twin.authorize(&signed, &signed)];

    let larger = ExitRequest {
        amount: 30_000_000,
        max_fee: 1_000,
    };
    twin.world.env.set_auths(&entries);
    assert!(!twin.exit(&larger));

    twin.world.env.set_auths(&entries);
    assert!(twin.exit(&signed));

    twin.world.env.set_auths(&entries);
    assert!(!twin.exit(&signed));
    assert_eq!(twin.world.usdc().balance(&twin.address), 30_000_000);
}
