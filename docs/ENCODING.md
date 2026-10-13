# Signing format

This document specifies what the owner of a Paso account signs and how the account contract checks it. It is complete enough to write a signer without the SDK.

Two implementations exist and must agree byte for byte:

- On chain: [`contracts/account/src/eip712.rs`](../contracts/account/src/eip712.rs) and [`contracts/account/src/render.rs`](../contracts/account/src/render.rs).
- Off chain: [`packages/sdk/src/typedData.ts`](../packages/sdk/src/typedData.ts), [`packages/sdk/src/render.ts`](../packages/sdk/src/render.ts) and [`packages/sdk/src/auth.ts`](../packages/sdk/src/auth.ts).

[`fixtures/vectors.json`](../fixtures/vectors.json) holds 11 vectors. Both test suites check the rendered text, the digest and the recovered signer of each one.

## 1. What is signed

A Soroban transaction carries one authorisation entry per address that must approve something. For a Paso account, that entry holds the tree of contract calls being authorised, a nonce, an expiry ledger and a signature.

The signature is an EIP-712 signature by the account's owner over one `Authorization` struct. The struct names the account, lists every call in the tree as text, and carries the 32-byte Soroban authorisation payload.

One entry, one signature. A signature cannot be split or combined.

## 2. Domain

```
EIP712Domain(string name,string version,bytes32 salt)
```

| Field | Value |
|---|---|
| `name` | `Paso` |
| `version` | `1` |
| `salt` | The Stellar network id: sha256 of the network passphrase |

There is no `chainId` and no `verifyingContract`. The network is bound by `salt`, and the account by a field of the message. The EVM chain the wallet happens to be connected to does not matter.

The message does not name the Stellar network in words either. A mainnet request and a testnet request for the same owner differ only in `salt` and in the addresses. A signer has to state the network next to the prompt; see [SECURITY.md](SECURITY.md#the-network-in-the-prompt).

| Network | Passphrase | `salt` | Domain separator |
|---|---|---|---|
| Testnet | `Test SDF Network ; September 2015` | `0xcee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472` | `0x8b4388cb9972512e45695f4d7f8c973b055d72fe0544b1fce5ad51ee79b5d518` |
| Mainnet | `Public Global Stellar Network ; September 2015` | `0x7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979` | `0x1a888e0bc92041bd4afe559e3704d9391ca71a0dc2d19b7534bef7cc6efb4179` |

On chain the salt is `env.ledger().network_id()`.

## 3. Types

```
Authorization(string account,Call[] calls,bytes32 payload)
Call(string contract,string fn,string[] args)
```

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
      { "name": "calls", "type": "Call[]" },
      { "name": "payload", "type": "bytes32" }
    ],
    "Call": [
      { "name": "contract", "type": "string" },
      { "name": "fn", "type": "string" },
      { "name": "args", "type": "string[]" }
    ]
  },
  "primaryType": "Authorization",
  "domain": { "name": "Paso", "version": "1", "salt": "<network id>" },
  "message": { "account": "<C…>", "calls": [], "payload": "<32 bytes>" }
}
```

Type hashes, as constants in the contract:

| Type string | keccak256 |
|---|---|
| `EIP712Domain(string name,string version,bytes32 salt)` | `0x599a80fcaa47b95e2323ab4d34d34e0cc9feda4b843edafcc30c7bdf60ea15bf` |
| `Authorization(string account,Call[] calls,bytes32 payload)Call(string contract,string fn,string[] args)` | `0xa205b454306e7b38649093df85ce38a688714f1ab37a797cb55ee61c17d240ea` |
| `Call(string contract,string fn,string[] args)` | `0x2f390aa144e2efdb324e5f3ff95cd7dba2d43c8ee1043a4c4f776911d4adf017` |
| `Paso` (the name) | `0x2bcde58e66140be1cc0a67cfadbb9c05abd4ea7fc7a873ce2644f66b613c0b7c` |
| `1` (the version) | `0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6` |

## 4. Message fields

| Field | Content |
|---|---|
| `account` | Strkey (`C…`) of the account contract that will check the signature. On chain it is `env.current_contract_address()`. When a Paso account acts as a delegated signer of another account, this is still the Paso account, not the account whose authority is used. |
| `calls` | One `Call` per contract call being authorised, in the order of section 6. |
| `calls[i].contract` | Strkey (`C…`) of the contract being called. |
| `calls[i].fn` | The function name: the characters of the Soroban symbol. |
| `calls[i].args` | One string per argument, rendered by the table in section 5. |
| `payload` | The 32-byte Soroban authorisation payload of the entry. Section 7. |

## 5. Rendering arguments

Each argument is a Soroban value (`ScVal`). It becomes one string.

| Soroban value | Text | Example | Vector |
|---|---|---|---|
| Address of an account | Strkey `G…` | `GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR` | `usdc_transfer` |
| Address of a contract | Strkey `C…` | `CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG` | `usdc_transfer` |
| `u32` | Base 10 | `4294967295` | `integers_bool_void` |
| `i32` | Base 10, `-` for negatives | `-2147483648` | `integers_bool_void` |
| `u64` | Base 10 | `18446744073709551615` | `integers_bool_void` |
| `i64` | Base 10, `-` for negatives | `-9223372036854775808` | `integers_bool_void` |
| `u128` | Base 10 | `340282366920938463463374607431768211455` | `integers_bool_void` |
| `i128` | Base 10, `-` for negatives | `-12345678901234567890123` | `negative_i128` |
| `bool` | `true` or `false` | `true` | `integers_bool_void` |
| void | `void` | `void` | `integers_bool_void` |
| `Symbol` | Its characters | `USDC_2026` | `symbol_and_string` |
| `String` | Its bytes, read as UTF-8 | `hello world` | `symbol_and_string` |
| `Bytes`, `BytesN` | `0x` and lowercase hex, two digits per byte | `0xdeadbeef` | `bytes_and_bytesn` |
| Anything else | `xdr:` and the lowercase hex sha256 of the value's XDR | `xdr:e576a3b77e94c9fd140b408ba1b55192c60f5778570ff89ef22d5e09cc62f560` for the vector `[1, 2, 3]` of `u32` | `vec_and_map_hashed` |

Rules that the examples do not show:

- Integers have no leading zeros, no `+`, no separators. Zero is `0`.
- Empty `Bytes` render as `0x`. An empty `Symbol` or `String` renders as the empty string.
- "Anything else" covers `Vec` and `Map`, which is how structs, tuples and most enums are encoded, as well as `u256`, `i256`, timepoints, durations, and addresses that are neither an account nor a contract, such as muxed accounts. The hash is over the XDR of the whole `ScVal`, type tag included. The token interface takes a muxed address as the destination of `transfer`, so the recipient of a transfer to an `M…` address renders as `xdr:…`.
- A `String` or `Symbol` whose bytes are not valid UTF-8 has no typed-data form. The contract hashes the raw bytes; the SDK refuses to prepare such a call.
- The bytes of a `String` are not escaped. Line breaks, control characters and direction overrides are part of the text, and so is a leading byte-order mark (`ef bb bf`): a signer has to hash it with the rest. A decoder that drops the mark produces a digest the contract will not rebuild.
- A `Bytes` argument above about 25 kB cannot be authorised. Rendering it as hex needs more memory than a mainnet transaction is allowed; 24,000 bytes fit and 26,000 do not. The squares of the lengths add up over all `Bytes` arguments of one authorisation. A `String` of the same size is cheap.
- The text carries no type. The `String` `true` and the `bool` `true` render the same; so do the number `5` and the string `5`. The exact values are still bound, by `payload`.

## 6. Call order

`calls` is the pre-order walk of the authorised invocation tree: the root call first, then each sub-call, depth first.

For a tree `root → [middle → [deep], last]` the order is `root`, `middle`, `deep`, `last`. This is the order in which the Soroban host hands the contexts to `__check_auth`. The contract test `host_lists_contexts_root_first_then_depth_first` runs that tree through the host's own authorisation path and shows that breadth-first, children-first and reversed-sibling orders are all refused.

The list is flat. It does not say which call is nested in which. The tree shape is bound by `payload`.

Only contract calls can be authorised. A tree that contains a contract creation is refused with `UnsupportedContext`.

## 7. Payload

`payload` is the value the Soroban host passes to `__check_auth` as `signature_payload`: the sha256 of the XDR of the entry's authorisation preimage.

The preimage contains:

- the network id,
- the entry's nonce,
- the signature expiration ledger,
- the root invocation with all its sub-invocations,
- and, for the address-bound credential encoding, the address of the account.

The preimage type follows the credential type of the entry. In `@stellar/stellar-sdk` the legacy encoding is `sorobanCredentialsAddress` and its preimage is `envelopeTypeSorobanAuthorization`; the address-bound encoding is `sorobanCredentialsAddressV2` and its preimage is `envelopeTypeSorobanAuthorizationWithAddress`. Simulation decides which one an entry gets. The linked transactions, on testnet and on mainnet, all use the address-bound encoding.

To build it:

1. Simulate the transaction with no authorisation attached. The simulation returns the entries the call needs.
2. Take the entry whose credentials name the account. There must be exactly one.
3. Set the entry's signature expiration ledger. The SDK uses at most the latest ledger plus 120, about ten minutes. The contract puts no limit on it and the host accepts any expiry that is within `max_entry_ttl − 1` ledgers of the ledger in which the entry is used, so keep it short: until that ledger the signature can be submitted by anyone who holds it.
4. Build the preimage for that entry and hash it with sha256.

With `@stellar/stellar-sdk` 17 the preimage is `buildAuthorizationEntryPreimage(entry, validUntilLedger, networkPassphrase)`; `authPayload` in the SDK wraps it.

The credential wrapper itself is not part of the preimage. The address-bound encoding and the delegated one, `sorobanCredentialsAddressWithDelegates`, give the same payload, so a signed entry can be re-wrapped with a list of delegates and still verify. The account ignores the delegates and the same call runs once.

The contract does not interpret `payload`. It hashes it into the struct as `bytes32`. The host computes the value from the entry that is actually submitted, so a signature made over one entry's payload cannot verify for another entry.

## 8. Hashing

Standard EIP-712.

```
hash(string)         = keccak256(UTF-8 bytes)
hash(string[])       = keccak256(hash(s0) ‖ hash(s1) ‖ …)
hashStruct(Call)     = keccak256(CALL_TYPE_HASH ‖ hash(contract) ‖ hash(fn) ‖ hash(args))
hash(Call[])         = keccak256(hashStruct(c0) ‖ hashStruct(c1) ‖ …)
hashStruct(Authorization)
                     = keccak256(AUTHORIZATION_TYPE_HASH ‖ hash(account) ‖ hash(calls) ‖ payload)
domainSeparator      = keccak256(DOMAIN_TYPE_HASH ‖ keccak256("Paso") ‖ keccak256("1") ‖ salt)
digest               = keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(Authorization))
```

An empty array hashes to `keccak256("")`, which is `0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`. The vector `no_arguments` covers it.

## 9. Signature

65 bytes: `r ‖ s ‖ v`. `r` and `s` are 32-byte big-endian integers.

| Rule | On violation |
|---|---|
| The last byte `v` is `0`, `1`, `27` or `28`. `0` and `27` mean recovery id 0; `1` and `28` mean recovery id 1. | `BadRecoveryId` (3) |
| `r` is in `[1, n)`, where `n` is the order of secp256k1. | `BadSignature` (2) |
| `s` is in `[1, n/2]`. High-`s` signatures are refused. | `BadSignature` (2) |
| The signature is exactly 65 bytes. | The value does not convert to the contract's 65-byte signature type and the transaction fails. |

The contract recovers the public key from `digest`, `r ‖ s` and the recovery id. It takes keccak256 of the 64-byte key, without the leading `0x04`, keeps the last 20 bytes, and compares them with the stored owner. A mismatch is `BadSignature`.

An `r` that is in range but is not the x-coordinate of a curve point makes the host abort instead of returning a typed error. The transaction fails either way.

One signature has two valid 65-byte encodings, with `v` as `0` or `27`, or as `1` or `28`. Do not use the bytes of a signature as an identifier.

64-byte compact signatures (EIP-2098) and smart-contract wallet signatures (ERC-1271) are not accepted. An owner address that is a contract can therefore never sign, and USDC sent to its account is lost.

## 10. Attaching and submitting

1. Put the 65 bytes in the entry's address credentials as the `signature` field, as an `ScVal` of type `Bytes`. Leave the nonce and the expiration ledger as they were when the payload was built.
2. Build a transaction with one `invokeHostFunction` operation: the contract call, and `auth` holding that one entry.
3. Simulate it again with the signed entry attached, so that the declared resources cover the account's signature check.
4. Any funded Stellar account signs the envelope and submits. That account pays the fee and decides nothing else.

A relayer takes the same two things as JSON: the host function and the signed entry. The request format is in [`packages/sdk/README.md`](../packages/sdk/README.md#relayer).

If the account contract does not exist yet, call `hub.deploy(owner)` first. Anyone may.

## 11. What binds what

| Threat | What stops it |
|---|---|
| The same signature submitted twice | The host consumes the entry's nonce. The nonce is inside `payload`. Hub test: `twin_signature_cannot_be_replayed_or_stretched`. |
| A signature used after it expires | The host refuses an entry past its signature expiration ledger. The ledger is inside `payload`. |
| A signature used again after its transaction failed | Nothing. A failed transaction rolls the nonce back, and the entry can be submitted again until its expiration ledger. Hub test: `f02_failed_transaction_leaves_the_signature_usable_by_anyone`. |
| A signature used for another account | `account` is rebuilt on chain from the address of the contract doing the check. Test: `rejects_other_account`. |
| A signature used on another network | `salt` is the network id, read on chain from the ledger. The network id is also inside `payload`. Test: `rejects_other_network`. |
| A changed argument, contract or function | The text is rebuilt from the calls the host supplies. Tests: `rejects_changed_argument`, `rejects_changed_recipient`, `rejects_changed_contract_or_function`. |
| A call added, removed or reordered | `hash(calls)` covers the whole list in order. Tests: `rejects_added_call`, `rejects_removed_call`, `rejects_reordered_calls`. |
| The mirrored form of a signature | `s` must be in the lower half of the curve order. Test: `rejects_high_s`. |

## 12. Errors

The account contract returns one of three errors from `__check_auth`.

| Code | Name | Meaning |
|---|---|---|
| 1 | `UnsupportedContext` | Something other than a contract call is being authorised. |
| 2 | `BadSignature` | Not signed by the owner over these exact calls, or `r` or `s` out of range. |
| 3 | `BadRecoveryId` | The last signature byte is not 0, 1, 27 or 28. |

In a failed transaction the host records a diagnostic event with the data `["failed account authentication with error", <account>, Error(Contract, #<code>)]`.

## 13. Worked example: vector `usdc_transfer`

All values below are from the vector named `usdc_transfer` in [`fixtures/vectors.json`](../fixtures/vectors.json). The private key is a fixed test key and controls nothing. In the vectors `account` is a test address and `payload` is a stand-in (sha256 of the text `paso vector: usdc_transfer`), not a payload built from a real entry.

Inputs:

| | |
|---|---|
| Network | testnet |
| Owner | `0xFCAd0B19bB29D4674531d6f115237E16AfCE377c` |
| Private key | `0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` |
| `account` | `CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG` |
| `payload` | `0x1c0f043fdd47ff1b83d0b479c2bad11fc6896ab235449a954756ad15c536ba1d` |
| `calls[0].contract` | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| `calls[0].fn` | `transfer` |

Arguments, from XDR to text:

| # | XDR (base64) | Value | Text |
|---|---|---|---|
| 0 | `AAAAEgAAAAGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoQ==` | contract address | `CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG` |
| 1 | `AAAAEgAAAAAAAAAAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=` | account address | `GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR` |
| 2 | `AAAACgAAAAAAAAAAAAAAAACYloA=` | `i128` 10000000 | `10000000` |

Hashes:

| Step | Value |
|---|---|
| `hash(args[0])`, also `hash(account)` | `0x8a01f2a8b76e1853d8bf6f457ed21b95bc05f6cb6d804c4ad5f96cefd879fe71` |
| `hash(args[1])` | `0xc97de7359ebbdfb48aa524da38b9b9bb3b78b0cf6cb4ee93ff5f65a96e2826d2` |
| `hash(args[2])` | `0x204e643c29c1c107bde84b5d4b708d642847949ce9f47120daf41797d5515ceb` |
| `hash(args)` | `0x803fb22f61755ef09833a76fb987b4dfe4844274379ca46dad50e80749b248c7` |
| `hash(contract)` | `0xa5d30e3c42310adf009a9201d9e1e4e3653fba9540b68b102a207d1f04ef94ce` |
| `hash(fn)` | `0xb483afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e` |
| `hashStruct(calls[0])` | `0xcf4197d49650769252a9e42a62036229b7712617cdfc35b50bfc414c234bbce8` |
| `hash(calls)` | `0xcc9db00a63351664a53e2f422cb2ea306063dbc763de88d75c8de33a9a0e3164` |
| `hashStruct(Authorization)` | `0x58636e21c4bfeaa1191e8c074465e4ca384dab135f3166c73eb4badf476cc1dd` |
| `domainSeparator` (testnet) | `0x8b4388cb9972512e45695f4d7f8c973b055d72fe0544b1fce5ad51ee79b5d518` |
| `digest` | `0x82240acaf992fe8990ecdbd9815daa8186a89d90e0c3c09fd39ea9ab2a594e14` |

Signature in the vector:

| | |
|---|---|
| `r` | `0xa340eed5b203effcebacb2d163dc2720cd50c120728598212ca6af1cba32e9e8` |
| `s` | `0x62f23935af909b2ee3866c873ba65142c18fb8a7f1ea0500fe55dc948bc97b8c` |
| `v` | `0x1c` (28, recovery id 1) |

Recovering the signer from `digest` and this signature gives `0xFCAd0B19bB29D4674531d6f115237E16AfCE377c`, the owner.

The vector `usdc_transfer_on_mainnet` has the same owner, account and arguments with the mainnet salt, the mainnet USDC contract and its own payload. Its digest is `0xf87ec658e788b294cb3f3d841f579c1971e6229f175f6f44fbcdba01f935027a`.

## 14. A live message with two calls

The exit in transaction [`6cae28f1…`](https://stellar.expert/explorer/testnet/tx/6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f) on Stellar testnet authorises `hub.exit` and the USDC `transfer` that `exit` makes on the account's behalf. One signature covers both.

```json
{
  "account": "CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME",
  "calls": [
    {
      "contract": "CBNSNERNVI7NW7JWDLOFJQJYMJC67EMVZLQONBBPWR4HLQMP53QGFOBO",
      "fn": "exit",
      "args": [
        "CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME",
        "5000000",
        "6",
        "0x0000000000000000000000007880da9a52af491f76421869d4e28dc0a4d1767c",
        "0",
        "1000"
      ]
    },
    {
      "contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "fn": "transfer",
      "args": [
        "CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME",
        "CBNSNERNVI7NW7JWDLOFJQJYMJC67EMVZLQONBBPWR4HLQMP53QGFOBO",
        "5000000"
      ]
    }
  ],
  "payload": "0x9314785b82b3c41da22f008c40b6a7bf2620692961bacd822957eb3f847fdea1"
}
```

| | |
|---|---|
| Domain | testnet |
| Digest | `0x1e054f9c2a3c9ebadf84dbe429c1b9a77fc401faa2017271f8be71e12e458fd0` |
| Signature | `0x04cea1342ce637ed50a31a9c13019ad07b2a873c16f60de8c48be1eebcf2c50c4318f1285db4fe25caa0aebeb5c594bbbb755d7a4899b9d393be803741d26e4c1c` |
| Recovered signer | `0x7880DA9a52Af491f76421869d4e28DC0A4D1767C` |

`pnpm verify 6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f` prints these values from chain data.

The same exit on mainnet is [`fccc2318…`](https://stellar.expert/explorer/public/tx/fccc2318b8322cc020fd0d6c0a84f05dea45a36725ae9ba24f36a6a7287d76c6). It is signed under the mainnet salt, names the mainnet hub and USDC contracts, and is checked with `pnpm verify fccc2318b8322cc020fd0d6c0a84f05dea45a36725ae9ba24f36a6a7287d76c6 --network mainnet`.

## 15. Checklist for a signer

1. Derive the account: the id of the contract the hub deploys with salt `12 zero bytes ‖ 20-byte owner address`. `hub.address_of(owner)` returns it.
2. Build the contract call and simulate it with no authorisation.
3. Require exactly one entry, with address credentials, for the account. Refuse anything else.
4. Set the signature expiration ledger on the entry.
5. Compute `payload` (section 7).
6. Walk the invocation tree in pre-order and render every call (sections 5 and 6).
7. Build the typed data (sections 2 to 4) and ask the wallet for `eth_signTypedData_v4`.
8. Check the result: 65 bytes, low `s`, `v` in `{0, 1, 27, 28}`. Recover the signer and compare it with the owner before sending anything.
9. Attach the signature and submit, or hand the call and the entry to a relayer (section 10).

Run the 11 vectors against your renderer and your hashing first. If your digest for `usdc_transfer` is `0x82240aca…4e14`, both match the contract.
