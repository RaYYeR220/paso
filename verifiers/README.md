# Paso EVM verifier

A signature verifier contract that lets an Ethereum address be a signer of a standard OpenZeppelin Stellar smart account.

OpenZeppelin's [smart accounts](https://docs.openzeppelin.com/stellar-contracts/accounts/smart-account) check signatures through separate verifier contracts: an account lists `External(verifier, key)` as a signer and asks the verifier whether a signature is good. The `stellar-accounts` package has verifiers for Ed25519 and WebAuthn. This one checks secp256k1 signatures made by an Ethereum key, addressed the Ethereum way: the key is a 20-byte address, and the signature is the 65 bytes a wallet returns from `eth_signTypedData_v4`.

It is deployed on Stellar testnet at [`CCNKAWI4…7H7FVX5`](https://stellar.expert/explorer/testnet/contract/CCNKAWI477PYRBW5O7NVYE7UBMDXB4OG74SXLQBJNVXZH4S3P7H7FVX5). It is not deployed on mainnet.

## Scope

What it does:

- An account that lists `External(<verifier>, <20-byte Ethereum address>)` accepts that address as a signer, alone or next to other signers and policies.
- The signature is EIP-712, so a wallet shows a named, structured request instead of asking for a raw hash with `eth_sign`.
- The contract keeps no state and has no constructor, no owner and no privileged function. One deployment serves any number of accounts.

What it does not do:

- **It does not show the calls.** A verifier receives 32 bytes from the account and nothing else. The wallet shows one field, `payload`, holding a hash. Nothing on screen says which contract is called, with which arguments, or which account is spending. The signer has to trust whatever produced the hash. Paso's own account ([`contracts/account`](../contracts/account)) is a different contract for that reason: it rebuilds the signed message on chain from the calls themselves, so what the wallet displays is what executes.
- It does not know which account is calling it, and the signed message names none. See [Limits](#limits).
- It does not manage keys. Adding, removing or replacing a signer is done on the account.

## Interface

The contract implements `stellar_accounts::verifiers::Verifier` from `stellar-accounts` 0.7.2.

```rust
fn verify(e: &Env, hash: Bytes, key_data: BytesN<20>, sig_data: BytesN<65>) -> bool;
fn canonicalize_key(e: &Env, key_data: BytesN<20>) -> Bytes;
fn batch_canonicalize_key(e: &Env, key_data: Vec<BytesN<20>>) -> Vec<Bytes>;
```

| Value | Content |
|---|---|
| `hash` | The 32 bytes the account wants checked. |
| `key_data` | The Ethereum address, 20 bytes. |
| `sig_data` | `r ‖ s ‖ v`, 65 bytes. `r` and `s` are 32-byte big-endian integers. |

`verify` returns `true` when `sig_data` is the signature of `key_data` over the EIP-712 message below, for `hash`, on the network the contract runs on. It returns `false` for a well-formed signature by any other key, or over any other payload or network; the account then fails with its own `ExternalVerificationFailed` (3003). Malformed input is an error:

| Input | Result |
|---|---|
| `hash` is not 32 bytes | `BadPayloadLength` (1) |
| `r` is not in `[1, n)`, or `s` is not in `[1, n/2]`, where `n` is the order of secp256k1. High-`s` signatures are refused. | `BadSignature` (2) |
| The last byte `v` is not `0`, `1`, `27` or `28`. `0` and `27` mean recovery id 0; `1` and `28` mean recovery id 1. | `BadRecoveryId` (3) |
| `key_data` is not 20 bytes, or `sig_data` is not 65 bytes | The value does not convert to the contract's type and the call fails. |
| `r` is in range but is not the x-coordinate of a curve point | The host refuses it and the call fails. |

`canonicalize_key` returns the address unchanged. An account uses it to refuse a rule that lists the same key twice.

64-byte compact signatures (EIP-2098) and smart-contract wallet signatures (ERC-1271) are not accepted.

## What is signed

```
EIP712Domain(string name,string version,bytes32 salt)
Authorization(bytes32 payload)
```

| Field | Value |
|---|---|
| `domain.name` | `Paso verifier` |
| `domain.version` | `1` |
| `domain.salt` | The Stellar network id: sha256 of the network passphrase. On chain it is `env.ledger().network_id()`. |
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
    "Authorization": [{ "name": "payload", "type": "bytes32" }]
  },
  "primaryType": "Authorization",
  "domain": { "name": "Paso verifier", "version": "1", "salt": "<network id>" },
  "message": { "payload": "<32 bytes>" }
}
```

Hashing is standard EIP-712:

```
hashStruct(Authorization) = keccak256(AUTHORIZATION_TYPE_HASH ‖ payload)
domainSeparator           = keccak256(DOMAIN_TYPE_HASH ‖ keccak256("Paso verifier") ‖ keccak256("1") ‖ salt)
digest                    = keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(Authorization))
```

The contract recovers the public key from `digest`, `r ‖ s` and the recovery id, takes keccak256 of the 64-byte key without its leading `0x04`, keeps the last 20 bytes and compares them with `key_data`.

Constants in the contract:

| Preimage | keccak256 |
|---|---|
| `EIP712Domain(string name,string version,bytes32 salt)` | `0x599a80fcaa47b95e2323ab4d34d34e0cc9feda4b843edafcc30c7bdf60ea15bf` |
| `Authorization(bytes32 payload)` | `0x36875b330647b16b56b42ac1af99cc282d8bfeb1ba91ac000d59dd91a61b7e7d` |
| `Paso verifier` | `0x658fc34f7f7c988b66c28182e1b35d5403cea66003e7ef74f9a24c3096e24c12` |
| `1` | `0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6` |

| Network | `salt` | Domain separator |
|---|---|---|
| Testnet | `0xcee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472` | `0x95dee67d2aa9eceb9b4e00a8efb9e6ae3a298da70a4917b74e25d9c916650bff` |
| Mainnet | `0x7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979` | `0x11855807d58ec536c5a942428d802e0258430c948b63a0a28018712794886e1a` |

[`evm/vectors/vectors.json`](evm/vectors/vectors.json) holds 8 vectors made with viem from fixed test keys. For the vector named `testnet`: the key `0x0123…cdef` (address `0xFCAd0B19bB29D4674531d6f115237E16AfCE377c`) signs the payload `0x7214aeaad7675913a0fba208d96abb9e96fbe29511b720abc74f978d476dcdba`; the digest is `0x5c996f94348b947b8bf1312ceda0313588544a12654fafe459755cc050719b70`.

### What the 32 bytes are

The account decides. The verifier does not interpret them.

An account built from `stellar-accounts` 0.7.2 passes `sha256(signature_payload ‖ XDR(context_rule_ids))`. `signature_payload` is the Soroban authorisation payload of the entry, which commits to the network, the entry's nonce, its expiration ledger and the whole tree of calls. `context_rule_ids` names the account rule chosen for each call.

So a signature covers one tree of calls under one nonce, until the entry expires, under the rules it was collected for, and the signer sees none of that. Whether it also covers one account only is a separate matter: see [Limits](#limits).

## Use it with an OpenZeppelin smart account

**Add the signer.** The signer value is `Signer::External(verifier, address)`: the verifier's contract id and the 20 address bytes. Pass it in the account's constructor, or to `add_signer(context_rule_id, signer)` on an existing account, which the account's current signers have to authorise. Key data of any other length is refused when the signer is added.

In Rust:

```rust
Signer::External(verifier, Bytes::from_array(&env, &address)) // address: [u8; 20]
```

With the TypeScript helper:

```ts
import { ethereumSigner } from "./src/openzeppelin";

const signer = ethereumSigner("CCNKAWI477PYRBW5O7NVYE7UBMDXB4OG74SXLQBJNVXZH4S3P7H7FVX5", "0x…");
```

**Sign an entry.** Simulate the transaction with no authorisation attached and take the entry simulation returns for the account. Then:

```ts
import { signPayload } from "./src/index";
import { attachSignature, entryPayload } from "./src/openzeppelin";

const validUntilLedger = simulation.latestLedger + 120;
const payload = entryPayload(entry, validUntilLedger, "testnet"); // the 32 bytes
const signature = await signPayload(account, payload, "testnet"); // wallet signs typedData(payload, "testnet")
const signed = attachSignature(entry, validUntilLedger, signature, { verifier, address: account.address });
```

`account` is anything with viem's `signTypedData`: a local account, or a wallet client with its account set. `entryPayload` takes entries with address-bound credentials only; see [Limits](#limits). Put `signed` in the operation's `auth`, simulate again so the declared resources cover the signature check, and have any funded Stellar account sign the envelope and submit. [`evm/js/demo.ts`](evm/js/demo.ts) does exactly this.

The helper in [`evm/js/src/index.ts`](evm/js/src/index.ts) covers the verifier and depends on viem only:

| Function | |
|---|---|
| `typedData(payload, network)` | The typed data for 32 bytes on `"testnet"`, `"mainnet"` or `{ networkPassphrase }`. |
| `signPayload(account, payload, network)` | Asks `account` to sign it and returns `r ‖ s ‖ v`. Checks the form the verifier accepts and, when `account.address` is set, that the signature recovers to it. |
| `digest`, `recoverSigner`, `networkId`, `assertUsableSignature` | The pieces of the above. |

[`evm/js/src/openzeppelin.ts`](evm/js/src/openzeppelin.ts) holds what is specific to the account: the signer value, the 32 bytes of an entry (`authDigest`, `entryPayload`) and the account's signature value (`authPayload`, `attachSignature`). It builds a signature value for one signer, which is all an account needs when the Ethereum key signs alone.

## Testnet

| | |
|---|---|
| Verifier | [`CCNKAWI477PYRBW5O7NVYE7UBMDXB4OG74SXLQBJNVXZH4S3P7H7FVX5`](https://stellar.expert/explorer/testnet/contract/CCNKAWI477PYRBW5O7NVYE7UBMDXB4OG74SXLQBJNVXZH4S3P7H7FVX5) |
| Wasm | 2,867 bytes, hash `9777e395f8a643bac49ff7fa5936964987ac50d8e58f94f7b87bab0f29f6b840` |
| Exports | `verify`, `canonicalize_key`, `batch_canonicalize_key` |
| Code uploaded | [`ef2cb01c…`](https://stellar.expert/explorer/testnet/tx/ef2cb01c82936802e5c66832af7cdcc6cc74857b26353e7ee98327c4820d14c7), 2026-10-12 18:51:52 UTC |
| Deployed | [`4046af48…`](https://stellar.expert/explorer/testnet/tx/4046af4836d6366cd8d196d0b19b7e6413483829a43b23b0a09f018e8f17efa6), 2026-10-12 18:51:57 UTC |

One run of the demo against it, on 2026-10-12, with an Ethereum key generated for the run (`0x207b55da3E383B7F1ad9BF7CDAE8FDD581e50ae4`). Times are ledger close times, UTC.

| Time | What happened | Transaction |
|---|---|---|
| 19:08:57 | OpenZeppelin smart account [`CBFSUOSY…WZYEOA5`](https://stellar.expert/explorer/testnet/contract/CBFSUOSYUSMPCIJOPM5QMQ2ZBLPLAAMO7H3PDXYGXXBZ47MRKWZYEOA5) deployed. Its default rule has no policy and one signer, `External(verifier, 0x207b55da…0ae4)` | [`a57dc8d5…`](https://stellar.expert/explorer/testnet/tx/a57dc8d5cc96082a2ab03580e9877916308584c7bfc2c6119524b4e45230c43d) |
| 19:09:02 | 10 XLM sent to the account through the native asset contract | [`4fe6bc99…`](https://stellar.expert/explorer/testnet/tx/4fe6bc99b53ee97fcb6efd8a53ef28ef11c4fbb956ff1d644a46d31c7282c5a0) |
| 19:09:07 | 1 XLM sent out of the account, authorised by the Ethereum key's signature. The account held 9 XLM afterwards | [`7921420b…`](https://stellar.expert/explorer/testnet/tx/7921420b79cfcecd8daad470b2d4351acce852780cf36860119d5ef594b0e4fe) |

The account code is the wasm that [`stellar/smart-account-kit`](https://github.com/stellar/smart-account-kit/blob/main/docs/deployments-protocol-27-2026-07-09.md) publishes on testnet, hash `1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a`: OpenZeppelin's `multisig-account-example` built from `OpenZeppelin/stellar-contracts` at `1e513890`. Nothing was built or uploaded for the account.

In the last transaction the wallet-side message was `{ "payload": "0xb2487bd96da56a5963af51466828ca42e5694b58dd2d86d19c722dc0e14c1b86" }` under the testnet domain. The signature carried in its authorisation entry recovers to `0x207b55da…0ae4`. Before it was sent, the same entry signed by a second generated key was simulated and refused with the account's error 3003; that attempt was not submitted.

Every transaction was sent and paid by one separate Stellar account, `GDTU3U4X…VSJ7XII`. The transfer out of the account was charged 0.1149531 XLM.

The run that deployed the verifier, and one more after it, made the same transfer from accounts of their own: [`a185ad10…`](https://stellar.expert/explorer/testnet/tx/a185ad10cef14ca7d631649add9931b840a498d31fc9e3a0deff41b7990835e4) and [`5544d3b2…`](https://stellar.expert/explorer/testnet/tx/5544d3b27c60205d199dfb423dc6d8072caf3f3563356ad8447a283f5c74f638).

## Build, test, run

This directory is a Cargo workspace of its own, apart from the contracts in [`../contracts`](../contracts): `stellar-accounts` 0.7.2 builds with `soroban-sdk` 26 and those contracts use a newer one. The two JavaScript packages are outside the repository's pnpm workspace and install on their own.

| Tool | Version |
|---|---|
| Rust | stable, with the `wasm32v1-none` target (`rust-toolchain.toml` selects both; built with 1.99.0) |
| Stellar CLI | 28.1.0 |
| Node.js | 24 |

```sh
cd verifiers
stellar contract build   # target/wasm32v1-none/release/paso_evm_verifier.wasm
cargo test               # 37 tests; they load the wasm, so build before testing

cd evm/js
npm install
npm test                 # 9 tests of the helper against the same vectors
npm run demo             # the testnet run above
```

`npm run demo` needs a funded stellar-cli identity on testnet: `paso-deployer` by default, or the one named in `PASO_DEPLOYER`. Create one with `stellar keys generate <name> --network testnet --fund`. The identity signs the transaction envelopes through `stellar tx sign`; the script reads no key from disk. It finds the verifier it deployed earlier from the same wasm and deploys a new account each time. It talks to testnet only.

To regenerate the vectors: `cd evm/vectors && npm install && npm run generate`.

### What the tests cover

The contract on its own, against the vectors ([`evm/src/test.rs`](evm/src/test.rs)). Each check runs on the natively compiled contract and on the built wasm and requires the same answer from both.

- The four constants equal keccak256 of their preimages; the digest and the domain separator match viem for every vector.
- Every vector is accepted, with `v` as 0, 1, 27 or 28.
- Refused: another signer's address, another key's signature, another payload (every single-bit change of it), another network, the domain of Paso's own account, a signature over the bare payload, a flipped recovery id.
- Errors: `v` out of range, high `s` (the mirrored form of every vector), `s` just above `n/2`, zero or out-of-range `r` and `s`, a payload that is not 32 bytes, key or signature data of the wrong length.

The verifier behind a real account ([`evm/src/account_test.rs`](evm/src/account_test.rs)). Every transfer goes through the host's authorisation path: a `SorobanAuthorizationEntry` is set, the token calls `require_auth`, the host calls the account's `__check_auth`, and the account calls the verifier wasm. Signatures are made in the test with `k256`. Each scenario runs on two builds of the account: the published wasm named above, and OpenZeppelin's example account compiled from the `stellar-accounts` 0.7.2 crate.

- An account with one `External(verifier, address)` signer and the default rule: a token transfer signed by the Ethereum key succeeds.
- A signature by another key fails with `ExternalVerificationFailed`. The same signature presented under that other key's address fails too, since the account does not list it.
- A signature does not carry over to another amount or another nonce, cannot be used twice, and does not pass when made over the Soroban payload instead of the account's digest.
- One of two: an account with an Ed25519 signer (OpenZeppelin's Ed25519 verifier), an Ethereum signer and OpenZeppelin's threshold policy set to 1. The Ethereum signer alone passes; so does the Ed25519 signer alone, and both together. A wrong Ethereum key, or no signature, does not.
- The account refuses to list the same address twice and refuses key data that is not 20 bytes.
- One signature serving two accounts under the legacy credential encoding: the limit described below.

The three OpenZeppelin wasm files in [`evm/fixtures/openzeppelin`](evm/fixtures/openzeppelin) were fetched from testnet by hash (`stellar contract fetch --wasm-hash <hash> --network testnet`). A test checks their sha256 against the hashes `stellar/smart-account-kit` lists: account `1b5f4534…7785a`, threshold policy `cb6c0bd9…6e592`, Ed25519 verifier `60e8798d…6b477`. They are MIT-licensed work of OpenZeppelin.

## Limits

- **Unaudited.** No external review of the contract or of the helper.
- **Testnet only.** Not deployed on mainnet and not used with funds of value.
- **The signer signs a hash.** The wallet cannot show which calls it stands for. An application that asks for this signature is trusted to have derived the hash from the calls it claims. When the calls should be readable in the wallet, use an account that rebuilds the message on chain, as Paso's own account does.
- **The verifier does not tie a signature to an account.** It cannot see its caller, and the domain names no account. Whether a signature is good for one account only depends on the 32 bytes the account passes. Entries with address-bound credentials (`sorobanCredentialsAddressV2`, which is what testnet simulation returned in the demo) put the account address in the Soroban payload. Entries with the legacy encoding do not, and a 0.7.2 account adds only the rule ids. Two accounts that list the same Ethereum address under the same rule id, asked to authorise the same call under the same nonce, then accept the same signature; the test `legacy_credentials_do_not_tie_a_signature_to_one_account` shows it. The helper's `entryPayload` refuses legacy entries for that reason.
- **Externally owned accounts only.** One 65-byte secp256k1 signature. Smart-contract wallets (ERC-1271) cannot sign.
- **No key rotation in the verifier.** It stores nothing. A lost or replaced key is handled on the account, with its own `add_signer` and `remove_signer`, by whoever its rules allow.
- **Tested against `stellar-accounts` 0.7.2.** The verifier interface is the same on OpenZeppelin's `main` branch (checked at `6b2f034`), where the account derives the 32 bytes differently: from a struct that also holds the account address. `authDigest` in the helper follows 0.7.2 and would have to follow that change. Nothing here was run against `main`.
- **The test host is older than testnet.** The contract tests run on the host of `soroban-sdk` 26.1.1 (protocol 26), which has the legacy credential encoding only. The address-bound encoding is covered by the testnet runs, on protocol 29.
- **Wallet extensions are untested.** Signatures in the tests and in the demo come from viem's EIP-712 signer and from `k256`. No wallet extension has been asked to sign this message, so how one lays it out on screen has not been checked.
- **One signer per signature value in the helper.** An account whose rule needs several signatures at once takes a map with one entry per signer; the helper does not build it.
