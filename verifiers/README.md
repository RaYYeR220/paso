# Paso EVM verifier

A signature verifier contract that lets an Ethereum address be a signer of a standard OpenZeppelin Stellar smart account.

OpenZeppelin's [smart accounts](https://docs.openzeppelin.com/stellar-contracts/accounts/smart-account) check signatures through separate verifier contracts: an account lists `External(verifier, key data)` as a signer and asks the verifier whether a signature is good. The `stellar-accounts` package has verifiers for Ed25519 and WebAuthn. This one checks secp256k1 signatures made by an Ethereum key: the signer is a 20-byte address, and the signature is the 65 bytes a wallet returns from `eth_signTypedData_v4`.

It is deployed on Stellar testnet at [`CBSBRBFV…MVV3L4ZX`](https://stellar.expert/explorer/testnet/contract/CBSBRBFVN6AYSRUPGDKRGPVIQHQDCXOOSE2AN7NY6WYF33JIMVV3L4ZX). It is not deployed on mainnet.

## Scope

What it does:

- An account that lists `External(<verifier>, <Ethereum address ‖ the account's own contract id>)` accepts that address as a signer, alone or next to other signers and policies.
- The signature is EIP-712. The wallet shows a named request that spells out which account it is for, instead of asking for a raw hash with `eth_sign`.
- A signature is made for one account. The key data of a signer names the account it belongs to, the verifier puts that account in the signed message, and a signature made for one account does not verify under key data that names another. This holds for both encodings of Soroban address credentials.
- The contract keeps no state and has no constructor, no owner and no privileged function. One deployment serves any number of accounts.

What it does not do:

- **It does not show the calls.** A verifier receives 32 bytes from the account and nothing else about what is being authorised. The wallet shows the account and one hash. Nothing on screen says which contract is called or with which arguments. The signer has to trust whatever produced the hash. Paso's own account ([`contracts/account`](../contracts/account)) is a different contract for that reason: it rebuilds the signed message on chain from the calls themselves, so what the wallet displays is what executes.
- **It does not check who calls it.** The binding is to the account id the signer was registered with, not to the caller: an account that registers a signer under another account's id accepts signatures made for that account, and weakens only itself. A verifier cannot see which contract calls it.
- It does not manage keys. Adding, removing or replacing a signer is done on the account.

## Interface

The contract implements `stellar_accounts::verifiers::Verifier` from `stellar-accounts` 0.7.2.

```rust
fn verify(e: &Env, hash: Bytes, key_data: Bytes, sig_data: BytesN<65>) -> bool;
fn canonicalize_key(e: &Env, key_data: Bytes) -> Bytes;
fn batch_canonicalize_key(e: &Env, key_data: Vec<Bytes>) -> Vec<Bytes>;
```

| Value | Content |
|---|---|
| `hash` | The 32 bytes the account wants checked. |
| `key_data` | 52 bytes: the Ethereum address (20), then the contract id of the smart account the signer belongs to (32). |
| `sig_data` | `r ‖ s ‖ v`, 65 bytes. `r` and `s` are 32-byte big-endian integers. |

`verify` returns `true` when `sig_data` is the signature of the address in `key_data` over the EIP-712 message below, for the account in `key_data` and for `hash`, on the network the contract runs on. It returns `false` for a well-formed signature by any other key, or made for any other account, payload or network; the account then fails with its own `ExternalVerificationFailed` (3003). Malformed input is an error:

| Input | Result |
|---|---|
| `hash` is not 32 bytes | `BadPayloadLength` (1) |
| `r` is not in `[1, n)`, or `s` is not in `[1, n/2]`, where `n` is the order of secp256k1. High-`s` signatures are refused. | `BadSignature` (2) |
| The last byte `v` is not `0`, `1`, `27` or `28`. `0` and `27` mean recovery id 0; `1` and `28` mean recovery id 1. | `BadRecoveryId` (3) |
| `key_data` is not 52 bytes | `BadKeyLength` (4) |
| `sig_data` is not 65 bytes | The value does not convert to the contract's type and the call fails. |
| `r` is in range but is not the x-coordinate of a curve point | The host refuses it and the call fails. |

`canonicalize_key` returns the 20-byte address, without the account id. An account uses the canonical form to refuse a rule that lists the same signer twice, and here the signer is the address: the same address followed by two different account ids is still one key, and counting it twice would let one key meet a threshold of two. Both canonical functions fail with `BadKeyLength` for key data that is not 52 bytes, so an account cannot register it.

64-byte compact signatures (EIP-2098) and smart-contract wallet signatures (ERC-1271) are not accepted.

## What is signed

```
EIP712Domain(string name,string version,bytes32 salt)
Authorization(string account,bytes32 payload)
```

| Field | Value |
|---|---|
| `domain.name` | `Paso verifier` |
| `domain.version` | `2` |
| `domain.salt` | The Stellar network id: sha256 of the network passphrase. On chain it is `env.ledger().network_id()`. |
| `message.account` | Strkey (`C…`) of the smart account the signer belongs to. On chain it is rendered from the contract id in the key data. |
| `message.payload` | The 32 bytes the account passes as `hash`. |

There is no `chainId` and no `verifyingContract`. The EVM chain the wallet is connected to does not matter. The domain name differs from the one Paso's own account uses (`Paso`), so a signature made for one is never valid for the other.

As JSON for `eth_signTypedData_v4`:

```json
{
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "salt", "type": "bytes32" }
    ],
    "Authorization": [
      { "name": "account", "type": "string" },
      { "name": "payload", "type": "bytes32" }
    ]
  },
  "primaryType": "Authorization",
  "domain": { "name": "Paso verifier", "version": "2", "salt": "<network id>" },
  "message": { "account": "<C…>", "payload": "<32 bytes>" }
}
```

Hashing is standard EIP-712:

```
hashStruct(Authorization) = keccak256(AUTHORIZATION_TYPE_HASH ‖ keccak256(account) ‖ payload)
domainSeparator           = keccak256(DOMAIN_TYPE_HASH ‖ keccak256("Paso verifier") ‖ keccak256("2") ‖ salt)
digest                    = keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(Authorization))
```

The contract recovers the public key from `digest`, `r ‖ s` and the recovery id, takes keccak256 of the 64-byte key without its leading `0x04`, keeps the last 20 bytes and compares them with the address in `key_data`.

Constants in the contract:

| Preimage | keccak256 |
|---|---|
| `EIP712Domain(string name,string version,bytes32 salt)` | `0x599a80fcaa47b95e2323ab4d34d34e0cc9feda4b843edafcc30c7bdf60ea15bf` |
| `Authorization(string account,bytes32 payload)` | `0xd662617b89a7a4ef5f9e73913643f186babea9b7101db8e280f65966ce8d3168` |
| `Paso verifier` | `0x658fc34f7f7c988b66c28182e1b35d5403cea66003e7ef74f9a24c3096e24c12` |
| `2` | `0xad7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5` |

| Network | `salt` | Domain separator |
|---|---|---|
| Testnet | `0xcee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472` | `0x68426afcc42851cbdb7e39d8ab1d4202e259bb4be9955a51794a6f7e3ae23788` |
| Mainnet | `0x7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979` | `0xdb8d598757156149bb9e0c43523ab79e4c02a140f9f3cfbccb533eaa7bc3c36e` |

[`evm/vectors/vectors.json`](evm/vectors/vectors.json) holds 9 vectors made with viem from fixed test keys, and the account's signature value for one and for two signers. For the vector named `testnet`: the key `0x0123…cdef` (address `0xFCAd0B19bB29D4674531d6f115237E16AfCE377c`) signs the payload `0x7214aeaad7675913a0fba208d96abb9e96fbe29511b720abc74f978d476dcdba` for the account `CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG`; the digest is `0x8f641c3a6530e22caa6fb0967a9d6841ac14ec3a0f52f5acf7fd19db84bb7acf`.

### What the 32 bytes are

The account decides. The verifier does not interpret them.

An account built from `stellar-accounts` 0.7.2 passes `sha256(signature_payload ‖ XDR(context_rule_ids))`. `signature_payload` is the Soroban authorisation payload of the entry, which commits to the network, the entry's nonce, its expiration ledger and the whole tree of calls. `context_rule_ids` names the account rule chosen for each call.

So a signature covers one tree of calls under one nonce, until the entry expires, under the rules it was collected for, for the account named in the message. Of these the signer sees the account and nothing else.

## Use it with an OpenZeppelin smart account

The signer value is `Signer::External(verifier, key data)`, with the key data described above. Because the key data names the account, the account's address has to be known when the signer is registered. There are two cases.

**The account exists.** Its address is known. Build the signer for it and pass it to `add_signer(context_rule_id, signer)` on the account, which the account's current signers have to authorise.

```ts
import { ethereumSigner } from "./src/openzeppelin";

const signer = ethereumSigner(verifier, "0x…", account); // account: the C… address
```

**The account is created with the signer.** The address of a contract depends only on the network, the deployer and the salt it is deployed with, so compute it first, build the signer for it, pass the signer to the constructor, and deploy from that deployer with that salt.

```ts
import { contractId } from "./src/index";
import { ethereumSigner } from "./src/openzeppelin";

const account = contractId(deployer, salt, "testnet"); // not deployed yet
const signer = ethereumSigner(verifier, "0x…", account);
// Operation.createCustomContract({ address: deployer, salt, wasmHash, constructorArgs: [signers, policies] })
```

In Rust the key data is the 20 address bytes followed by the 32 bytes of the contract id:

```rust
Signer::External(verifier, Bytes::from_array(&env, &key_data)) // key_data: [u8; 52]
```

Key data of any other length is refused when the signer is added. Key data that names a different account is not: the verifier cannot tell. Such a signer signs for that other account, not for the one that listed it.

**Sign an entry.** Simulate the transaction with no authorisation attached and take the entry simulation returns for the account. Then:

```ts
import { signPayload } from "./src/index";
import { attachSignatures, entryAddress, entryPayload } from "./src/openzeppelin";

const validUntilLedger = simulation.latestLedger + 120;
const account = entryAddress(entry);
const payload = entryPayload(entry, validUntilLedger, "testnet"); // the 32 bytes
const signature = await signPayload(wallet, account, payload, "testnet"); // wallet signs typedData(account, payload, "testnet")
const signed = attachSignatures(entry, validUntilLedger, verifier, [{ address: wallet.address, signature }]);
```

`wallet` is anything with viem's `signTypedData`: a local account, or a wallet client with its account set. Put `signed` in the operation's `auth`, simulate again so the declared resources cover the signature check, and have any funded Stellar account sign the envelope and submit. [`evm/js/demo.ts`](evm/js/demo.ts) does exactly this, for both ways of registering a signer.

The helper in [`evm/js/src/index.ts`](evm/js/src/index.ts) covers the verifier:

| Function | |
|---|---|
| `typedData(account, payload, network)` | The typed data for 32 bytes and the account they are for, on `"testnet"`, `"mainnet"` or `{ networkPassphrase }`. |
| `signPayload(signer, account, payload, network)` | Asks `signer` to sign it and returns `r ‖ s ‖ v`. Checks the form the verifier accepts and, when `signer.address` is set, that the signature recovers to it. |
| `keyData(address, account)` | The 52 bytes of a signer. |
| `contractId(deployer, salt, network)` | The address of the contract a deployer creates with a salt. |
| `digest`, `recoverSigner`, `networkId`, `assertUsableSignature` | The pieces of the above. |

[`evm/js/src/openzeppelin.ts`](evm/js/src/openzeppelin.ts) holds what is specific to the account: the signer value (`ethereumSigner`), the 32 bytes of an entry (`authDigest`, `entryPayload`) and the account's signature value (`authPayload`, `attachSignatures`). The signature value can carry several Ethereum signers of one verifier, in the key order Soroban requires. Entries of both credential encodings are prepared the same way.

## Testnet

| | |
|---|---|
| Verifier | [`CBSBRBFVN6AYSRUPGDKRGPVIQHQDCXOOSE2AN7NY6WYF33JIMVV3L4ZX`](https://stellar.expert/explorer/testnet/contract/CBSBRBFVN6AYSRUPGDKRGPVIQHQDCXOOSE2AN7NY6WYF33JIMVV3L4ZX) |
| Wasm | 3,325 bytes, hash `c49e81a0b5e718eddddd9a1ccf505627e30e1a59586538d6e44201e7a96fb017` |
| Exports | `verify`, `canonicalize_key`, `batch_canonicalize_key` |

One run of the demo on 2026-10-13. It generated two Ethereum keys, `0x0Fe5fdC47Dd1aa091Ef6022050d22E1ACa560bbc` and `0xb9A82D438cbE8EE66A2b79acf79d87b625F908F0`. Times are ledger close times, UTC.

| Time | What happened | Transaction |
|---|---|---|
| 06:22:17 | Verifier code uploaded | [`3e995c16…`](https://stellar.expert/explorer/testnet/tx/3e995c16e6b03aa7fce1a4fcf4b95dbefd220d3c1e3156e0b124a62ed04881bb) |
| 06:22:22 | Verifier deployed | [`be93917a…`](https://stellar.expert/explorer/testnet/tx/be93917ab42a19c971b698744bfb0eb6a3394cefe44dd1140f266e4cbd9c2c85) |
| 06:22:27 | OpenZeppelin smart account [`CANPF7F5…ZU5OKIX`](https://stellar.expert/explorer/testnet/contract/CANPF7F52EFQ3GQFDFYUHHUPDQPM2FBX7S77YHKQBGVGK7PR4ZU5OKIX) created with the first key as its only signer. The address was computed from the deployer and a salt beforehand and put in the signer's key data | [`907ffc6f…`](https://stellar.expert/explorer/testnet/tx/907ffc6fc877f440df194b3faf5069eb073eed46c9ff47d9bc44d36cb77372fc) |
| 06:22:32 | 10 XLM sent to the account through the native asset contract | [`14e1a2db…`](https://stellar.expert/explorer/testnet/tx/14e1a2db02d284f71caf16ccd85e566fd60d1099bac2698aa0305103ca4e5424) |
| 06:22:37 | 1 XLM sent out of the account, authorised by the first key's signature | [`c2e7aeba…`](https://stellar.expert/explorer/testnet/tx/c2e7aeba2ca6866cad76c1d31eb2303781ff6c9ca5b357aa51bc22b14bbb2f68) |
| 06:22:42 | The second key added to the existing account as a signer: `add_signer` on the account, authorised by the first key's signature | [`5d12dab6…`](https://stellar.expert/explorer/testnet/tx/5d12dab6f0206fd46ae6b7ad32a983b55ceee57566edc5dc0a849da231cb44ce) |
| 06:22:47 | 1 XLM sent out of the account, authorised by both keys' signatures. The account held 8 XLM afterwards | [`9073d3c2…`](https://stellar.expert/explorer/testnet/tx/9073d3c290251c10ffd2718a9bc9173fbd601e0b36c8900d75d5e44b3fde7012) |

The account code is the wasm that [`stellar/smart-account-kit`](https://github.com/stellar/smart-account-kit/blob/main/docs/deployments-protocol-27-2026-07-09.md) publishes on testnet, hash `1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a`: OpenZeppelin's `multisig-account-example` built from `OpenZeppelin/stellar-contracts` at `1e513890`. Nothing was built or uploaded for the account.

For the first transfer the wallet-side message was `{ "account": "CANPF7F52EFQ3GQFDFYUHHUPDQPM2FBX7S77YHKQBGVGK7PR4ZU5OKIX", "payload": "0x0dbc3ec004cce645db8bfaf29967b21fa62b1e7e1f76e118cb1566c1b32de897" }` under the testnet domain. In each of the last three transactions, every signature in the authorisation entry recovers to the address in its signer's key data, and that key data ends in the account's contract id.

Four more entries were simulated during the run, refused by the account, and not submitted:

| Attempt | Refused with |
|---|---|
| The first transfer, the same message signed by a third key | 3003, `ExternalVerificationFailed` |
| The first transfer, the same 32 bytes signed by the first key for another account | 3003 |
| `add_signer`, signed by the key being added | 3003 |
| The second transfer, signed by the first key alone | 3002, `UnvalidatedContext`: the rule has no policy and takes every signer it lists |

Every transaction was sent and paid by one separate Stellar account, `GDTU3U4X…VSJ7XII`. The three transactions the account authorised were charged 0.1224259, 0.0324811 and 0.0618928 XLM.

A second run found the verifier in place and repeated the rest with new keys and a new account, `CBY5R6EPYVON56PAV6GU2BDSIYKJ6QM4OU4KIGUGTLSF2KS6KPQUSESF`. Its last transfer, signed by both of its keys, is [`838f2fca…`](https://stellar.expert/explorer/testnet/tx/838f2fca1fc11bbf8f6ca11c2f72d9952254838edc0026949d74af2ec63b728b).

An earlier build of this verifier, whose message named no account (domain version `1`, 20-byte key data), remains on testnet at `CCNKAWI477PYRBW5O7NVYE7UBMDXB4OG74SXLQBJNVXZH4S3P7H7FVX5`: a deployed contract cannot be removed. It should not be used. Its signatures do not verify here.

## Build, test, run

This directory is a Cargo workspace of its own, apart from the contracts in [`../contracts`](../contracts): `stellar-accounts` 0.7.2 builds with `soroban-sdk` 26 and those contracts use a newer one. The two JavaScript packages are outside the repository's pnpm workspace and install on their own.

| Directory | |
|---|---|
| [`evm`](evm) | The contract, `paso-evm-verifier`, with its tests, vectors and helper. |
| [`host29`](host29) | Tests only. They run the built verifier behind the published account wasm on the host of `soroban-sdk` 29 (protocol 29), which knows both encodings of address credentials. The host that `stellar-accounts` 0.7.2 builds with knows the legacy one only. |

| Tool | Version |
|---|---|
| Rust | stable, with the `wasm32v1-none` target (`rust-toolchain.toml` selects both; built with 1.99.0) |
| Stellar CLI | 28.1.0 |
| Node.js | 24 |

```sh
cd verifiers
stellar contract build   # target/wasm32v1-none/release/paso_evm_verifier.wasm
cargo test               # 45 tests: 43 in evm, 2 in host29. They load the wasm, so build before testing

cd evm/js
npm install
npm test                 # 14 tests of the helper against the same vectors
npm run demo             # the testnet run above
```

`npm run demo` needs a funded stellar-cli identity on testnet: `paso-deployer` by default, or the one named in `PASO_DEPLOYER`. Create one with `stellar keys generate <name> --network testnet --fund`. The identity signs the transaction envelopes through `stellar tx sign`; the script reads no key from disk. It finds the verifier it deployed earlier from the same wasm and creates a new account each time. It talks to testnet only.

To regenerate the vectors: `cd evm/vectors && npm install && npm run generate`.

### What the tests cover

The contract on its own, against the vectors ([`evm/src/test.rs`](evm/src/test.rs)). Each check runs on the natively compiled contract and on the built wasm and requires the same answer from both.

- The four constants equal keccak256 of their preimages; the digest and the domain separator match viem for every vector; the account is rendered as its strkey.
- Every vector is accepted, with `v` as 0, 1, 27 or 28.
- Refused: another signer's address, another key's signature, another account (the same key and payload, and every single-bit change of the account id), another payload (every single-bit change of it), another network, the domain of Paso's own account, the version 1 domain and message, a signature over the bare payload, a flipped recovery id.
- Errors: `v` out of range, high `s` (the mirrored form of every vector), `s` just above `n/2`, zero or out-of-range `r` and `s`, a payload that is not 32 bytes, key data that is not 52 bytes (the bare address among them), signature data of the wrong length.
- The canonical key is the address alone, the same for one address under two account ids.

The verifier behind a real account ([`evm/src/account_test.rs`](evm/src/account_test.rs)). Every call goes through the host's authorisation path: a `SorobanAuthorizationEntry` is set, the called contract calls `require_auth`, the host calls the account's `__check_auth`, and the account calls the verifier wasm. Signatures are made in the test with `k256`. Each scenario runs on two builds of the account: the published wasm named above, and OpenZeppelin's example account compiled from the `stellar-accounts` 0.7.2 crate.

- An account with one Ethereum signer and the default rule: a token transfer signed by the key succeeds.
- A signature by another key fails with `ExternalVerificationFailed`. The same signature presented under that other key's address fails too, since the account does not list it.
- A signature does not carry over to another amount or another nonce, cannot be used twice, and does not pass when made over the Soroban payload instead of the account's digest.
- One of two: an account with an Ed25519 signer (OpenZeppelin's Ed25519 verifier), an Ethereum signer and OpenZeppelin's threshold policy set to 1. The Ethereum signer alone passes; so does the Ed25519 signer alone, and both together. A wrong Ethereum key, or no signature, does not.
- A signer added to an existing account: the current signer authorises `add_signer`, and the rule then takes both signatures and neither alone.
- The account refuses the same address twice, whatever account id follows it, and refuses key data that is not 52 bytes with the verifier's `BadKeyLength`.
- A signature for one account fails on another that lists the same address. The two accounts are asked to authorise the same call under the same nonce, so that with legacy credentials they hand the verifier the same 32 bytes.
- The limit of that binding: an account whose signer was registered under another account's id accepts the signatures made for that other account, and refuses the ones made for itself.

The same on a current host ([`host29/src/test.rs`](host29/src/test.rs)), with the published account wasm, once per credential encoding:

- A transfer is authorised with legacy credentials and with address-bound ones. A signature over the other encoding's payload is refused.
- A signature for one account fails on another that lists the same address, under both encodings. So does a signature over the second account's own payload made for the first account, where the account in the message is the only thing wrong.

The three OpenZeppelin wasm files in [`evm/fixtures/openzeppelin`](evm/fixtures/openzeppelin) were fetched from testnet by hash (`stellar contract fetch --wasm-hash <hash> --network testnet`). A test checks their sha256 against the hashes `stellar/smart-account-kit` lists: account `1b5f4534…7785a`, threshold policy `cb6c0bd9…6e592`, Ed25519 verifier `60e8798d…6b477`. They are MIT-licensed work of OpenZeppelin.

## Limits

- **Unaudited.** No external review of the contract or of the helper.
- **Testnet only.** Not deployed on mainnet and not used with funds of value.
- **The signer signs a hash.** The wallet shows the account and cannot show which calls the hash stands for. An application that asks for this signature is trusted to have derived the hash from the calls it claims. When the calls should be readable in the wallet, use an account that rebuilds the message on chain, as Paso's own account does.
- **The account in the message is the registered one, not the caller.** The verifier cannot see which contract calls it. It checks a signature against the account id in the key data, whoever asks. Registering a signer under the id of some other account makes the registering account accept signatures made for that other account, when the 32 bytes also match, and refuse the ones made for itself. Nothing changes for the other account. The test `the_account_named_is_the_one_registered_not_the_caller` shows both halves.
- **The account's address must be known when a signer is registered.** For an account that is created with its signers, that means computing the address from the deployer and the salt first, and deploying with exactly those. A signer registered for the wrong address cannot sign for the account.
- **Externally owned accounts only.** One 65-byte secp256k1 signature per signer. Smart-contract wallets (ERC-1271) cannot sign.
- **No key rotation in the verifier.** It stores nothing. A lost or replaced key is handled on the account, with its own `add_signer` and `remove_signer`, by whoever its rules allow.
- **Tested against `stellar-accounts` 0.7.2.** The verifier interface is the same on OpenZeppelin's `main` branch (checked at `6b2f034`), where the account derives the 32 bytes differently: from a struct that also holds the account address. `authDigest` in the helper follows 0.7.2 and would have to follow that change. Nothing here was run against `main`.
- **Wallet extensions are untested.** Signatures in the tests and in the demo come from viem's EIP-712 signer and from `k256`. No wallet extension has been asked to sign this message, so how one lays it out on screen has not been checked.
- **The helper builds signature values for this verifier only.** Several Ethereum signers of one verifier can sign together. An account that also needs signatures checked by other verifiers takes a map with those signers in it, which the helper does not build.
