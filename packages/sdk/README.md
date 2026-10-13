# paso-sdk

Every Ethereum address already has a Stellar account. This package finds it, funds it from Base, Ethereum, Arbitrum, OP Mainnet or Arc and lets the same Ethereum key control it.

- **Derive.** `twinAddress(owner, network)` returns the Stellar contract account (`C…`) of an Ethereum address. It is pure arithmetic: the account can receive USDC before it is deployed.
- **Fund.** `fundFromEvm` burns USDC on an EVM chain through Circle's CCTP; `waitForAttestation` follows the transfer until it can be delivered on Stellar.
- **Act.** `prepare` simulates a transfer, a withdrawal to an EVM chain, or any contract call, and returns EIP-712 typed data. `sign` asks the wallet. `relay` hands the result to a relayer that pays the fee, or `submitWith` sends it from any funded Stellar account.

The wallet shows the real calls: contract, function and every argument as text. The account contract rebuilds that same text from what is about to execute and rejects the signature if anything differs.

## Install

```sh
npm install paso-sdk viem
```

Published on npm as [`paso-sdk`](https://www.npmjs.com/package/paso-sdk). ESM only, Node 22.12 or later, or any modern bundler. The deployed contract ids for Stellar testnet and mainnet are built in.

To work on the SDK itself, use it from the repository, <https://github.com/RaYYeR220/paso>: it is the pnpm workspace package in `packages/sdk`. Run `pnpm install` and then `pnpm build:sdk` at the root; the web app and the scripts there use that copy.

## Usage

```ts
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { baseSepolia } from "viem/chains";
import { fundFromEvm, parseStellarAmount, prepare, relay, sign, twinAddress, waitForAttestation } from "paso-sdk";

const [owner] = await window.ethereum.request({ method: "eth_requestAccounts" });
const walletClient = createWalletClient({ account: owner, chain: baseSepolia, transport: custom(window.ethereum) });
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

const account = twinAddress(owner, "testnet"); // C…, known before anything is deployed

// Bring 5 USDC over from Base and follow it until Circle has attested the burn.
const { burnTxHash } = await fundFromEvm({ walletClient, publicClient, amount: 5_000_000n, owner, network: "testnet" });
await waitForAttestation(6, burnTxHash, "testnet", { onStatus: (status) => console.log(status.state) });

// Send 1.5 USDC to the Stellar account of another Ethereum address: one wallet prompt, no XLM.
const prepared = await prepare(
  { kind: "transfer", to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", amount: parseStellarAmount("1.5") },
  { owner, network: "testnet" },
);
const signed = await sign(prepared, walletClient); // the wallet shows prepared.calls
const { hash } = await relay(signed, "https://example.org/api/relay");
```

Base is the default chain. To bring USDC from another one, connect the wallet to it and name it: `fundFromEvm({ ..., chain: "arc" })`, then `waitForAttestation("arc", burnTxHash, "testnet")`. The names are `base`, `ethereum`, `arbitrum`, `optimism` and `arc`; [Networks](#networks) lists them. An `exit` names its chain in `destinationChain`.

`sign` accepts a viem account or a wallet client that has its account set. For a wallet client without one, wrap it: `{ signTypedData: (data) => walletClient.signTypedData({ ...data, account }) }`.

## Actions

| Action | What runs on Stellar |
|---|---|
| `{ kind: "transfer", to, amount }` | USDC `transfer(account, to, amount)`. `to` is `G…`, `C…`, or `0x…` for the Stellar account of that Ethereum address. A muxed `M…` address is refused: a wallet could only show it as a hash. |
| `{ kind: "exit", amount, recipient }` | `hub.exit(account, amount, domain, recipient, max_fee, min_finality_threshold)`: USDC leaves for `recipient` on Base, or on `destinationChain` (`"ethereum"`, `"arbitrum"`, `"optimism"`, `"arc"`). Optional `destinationChain`, `destinationDomain`, `maxFee`, `minFinalityThreshold`. |
| `{ kind: "invoke", contract, fn, args }` | Any contract function that asks the account for authorisation. |

`prepare(action, { owner, network })` returns plain JSON: `{ network, owner, account, txXdr, entries, typedData, calls, validUntilLedger, preparedAtLedger }`. `entries` holds exactly one authorisation entry, the account's: a call that also needs the authorisation of anyone else, the fee payer included, is refused at this point.

### How long a signature lasts

The signature is accepted up to and including `validUntilLedger`. By default that is `DEFAULT_VALIDITY_LEDGERS` (24 ledgers, about two minutes) after `preparedAtLedger`, the latest ledger when the call was simulated. `validForLedgers` changes it, up to `MAX_VALIDITY_LEDGERS` (120 ledgers, about ten minutes). `prepare` refuses a longer validity, and one that is not a positive whole number, before it contacts the network.

`isExpired(prepared, latestLedger)` tells when to prepare again. `validForSeconds(prepared, latestLedger)` gives roughly how many seconds are left, counting `LEDGER_SECONDS` (5) for each ledger, and 0 once the signature is expired.

Until its last valid ledger a signature can be submitted by anyone who holds it, and a transaction that fails does not use it up. After a failed attempt, send the same signed call again while it is valid. Signing a second one leaves two live signatures for one payment, and both can land.

## What the wallet signs

```
domain  { name: "Paso", version: "1", salt: <network id> }       no chainId, no verifyingContract

Authorization(string account,Call[] calls,bytes32 payload)
Call(string contract,string fn,string[] args)
```

`account` is the account's strkey. `calls` lists every call the signature authorises, root first, then nested calls depth first. `payload` is the 32-byte Soroban authorisation payload, which binds the network, the nonce, the expiry and the full call tree.

Arguments are rendered by `renderArg`:

| Soroban value | Text |
|---|---|
| Address (account or contract) | strkey, `G…` or `C…` |
| u32, i32, u64, i64, u128, i128 | base 10, `-` for negatives |
| bool | `true` / `false` |
| void | `void` |
| Symbol | its characters |
| String | its bytes as UTF-8 |
| Bytes, BytesN | `0x` and lowercase hex |
| anything else (Vec, Map, u256, …) | `xdr:` and the lowercase hex sha256 of the value's XDR |

`typedData(...)` and `digest(...)` build and hash this structure directly; `renderCalls(entry)` turns an authorisation entry into the `calls` list.

The account hashes the bytes of a `String` or `Symbol` as they are, so the text keeps every byte, a leading byte-order mark included. Bytes that are not valid UTF-8 cannot be handed to a wallet, and `prepare` refuses such a call.

### What the text does not say

The signed text has no types and is not escaped. The number `5` and the string `5` look the same. A `String` can hold a line break, a strkey, or text that reads like `fn: transfer`. A value bound by hash cannot be read at all.

`describeCalls(entry)` lists the same calls as `renderCalls`, in the same order and with the same text, and adds what the text leaves out: `{ contract, fn, fnConcerns, args }`, each argument as `{ text, type, hashed, concerns }`. `type` is the Soroban type in a word (`address`, `i128`, `string`, `bytes`, …; for a hashed value its kind: `vec`, `map`, `u256`, `muxed address`, …). `describeArg(value)` describes one value and `textConcerns(text)` checks any string.

| Concern | Reported for |
|---|---|
| `control` | A control character: U+0000–U+001F except `\n` and `\r`, and U+007F–U+009F. |
| `newline` | A line break: `\n`, `\r`, U+0085, U+2028, U+2029. U+0085 is reported as `control` too. |
| `bidi` | A character that changes the direction of text: U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C. |
| `invisible` | A character that takes no room: U+200B–U+200D, U+2060, U+FEFF, U+00AD, U+180E. |
| `looks_like_field` | Text shaped like another line of the message: `fn`, `contract`, `account`, `args`, `payload` or `calls`, quoted or not, followed by `:` or `=`. |
| `looks_like_address` | Text that is or contains the shape of a strkey or of an Ethereum address. A real address argument renders the same. |
| `looks_like_hash` | Text that contains `xdr:` and 64 hex digits, or is `0x` and whole hex bytes, as bytes are shown. |
| `hashed` | The value is `xdr:<sha256>`: bound by the signature, not readable. |

The first seven apply to `String` and `Symbol` arguments and to function names, and come in this order. They are shapes, not proofs: a look-alike letter from another alphabet is not caught. None of this is signed. It is for a front end to show next to the wallet prompt.

## Funding from an EVM chain

`fundFromEvm({ walletClient, publicClient, amount, owner, network, chain, route })` approves Circle's TokenMessenger when the allowance is short, then burns. `chain` is the chain the USDC leaves (`"base"` when absent); the wallet has to be connected to it. The burn asks for a fast transfer where Circle offers one, and for a standard transfer from Arc, which Circle attests within seconds and for nothing; `minFinalityThreshold` overrides that. `amount` is in 6-decimal units on every chain; the payer need not be the owner.

| `route` | Burn on the EVM chain | Delivery on Stellar |
|---|---|---|
| `"forwarder"` (default) | `depositForBurnWithHook`, mint recipient and destination caller set to Circle's CctpForwarder, the account named in the hook data | `mintAndForwardOperation(message, attestation, network)` |
| `"direct"` | `depositForBurn`, mint recipient set to the account's contract id, no destination caller | `receiveMessageOperation(caller, message, attestation, network)` |

`waitForAttestation(source, txHash, network, { signal, onStatus })` polls Circle's Iris service until the burn is attested and resolves to `{ message, attestation, nonce }`. It reports `not_found`, `pending`, `unreachable` and `complete` through `onStatus` and keeps polling until aborted. `fetchAttestation(source, txHash, network)` asks once and returns `{ status, attestation? }`. `source` is a CCTP domain, a chain's name (`"arc"`) or `"stellar"`; `fetchBurnFee` takes both ends the same way. For a burn made on Stellar, `txHash` is the transaction hash without `0x`.

`findBurnSource(txHash, network)` tells which chain a burn was made on from its hash alone: it asks Iris under the domain of every chain listed, all at once, and answers `found` with the chain and what Iris holds, `not_found`, `unreachable`, or `ambiguous`.

`deliverOperation({ message, attestation, caller }, network)` picks the right delivery call from the message itself, and `deliverWith({ message, attestation }, keypair, network)` submits it from any funded Stellar account. Delivery is permissionless: Circle's contracts check the attestation and decide where the USDC goes. From a checkout of the repository, `pnpm deliver <burn tx hash> [--chain <name>] --network <testnet|mainnet>` does the same for a burn on any chain listed, with `PASO_SOURCE_SECRET` set to any funded Stellar account; without `--chain` it finds the chain from the hash. It needs no key of the account's owner.

The way back ends on the EVM chain: `receiveMessageOnEvm({ walletClient, publicClient, message, attestation, network, chain })` hands the attested exit to Circle's MessageTransmitter there, and `isReceivedOnEvm(publicClient, message, network, chain)` says whether that has happened. `chain` defaults to Base; a message for another chain than the one named is refused before anything is sent. `pnpm mint <stellar exit tx hash>` mints on the chain the message names.

## Relayer

`relay(signed, url)` sends one `POST` with a JSON body:

```json
{
  "network": "testnet",
  "owner": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "func": "<base64 HostFunction XDR>",
  "auth": ["<base64 SorobanAuthorizationEntry XDR>"]
}
```

- `network`: `"testnet"` or `"mainnet"`.
- `owner`: the Ethereum address that owns the account, so the relayer can deploy the account before its first call.
- `func`: the host function to invoke.
- `auth`: one element, the account's authorisation entry with the owner's signature attached.

The relayer answers `200` with `{ "hash": "<transaction hash>" }`, plus `"deployHash"` when it deployed the account for this first call, or a non-2xx status with `{ "error": "<code>", "detail": "…" }`. `relay` throws a `RelayError` carrying that `error` as `code`:

| `error` | Meaning |
|---|---|
| `expired` | The signature's last valid ledger has passed. Prepare and sign again. |
| `bad_signature` | The account refused the signature for this call. |
| `simulation_failed` | The call itself would fail, or costs more than the relayer pays for. |
| `bad_request` | The request is not one signed call from the owner's account. |
| `rate_limited` | Too many requests; try again later. |
| `transaction_failed` | The transaction was submitted and did not apply. |
| `unavailable` | The relayer could not reach the network. |

A relayer builds its own transaction around `func` and `auth` and pays the fee. It can decline. It cannot change the call or its arguments: the signature covers them. The types are exported as `RelayRequest`, `RelayResult` and `RelayResponse`, and `relayRequest(signed)` builds the body.

Without a relayer, `submitWith(signed, keypair)` does the same from any funded Stellar account, deploying the owner's account first if it does not exist.

### What a fee payer will not pass along

Whoever pays the fee signs the transaction envelope, and on Stellar that signature also satisfies any authorisation entry with source-account credentials. A fee payer that forwarded entries unchecked could be made to authorise a transfer of its own funds. So every path that puts someone else's signed call into a transaction first runs `assertOnlyAccountEntries(entries, account)`:

- exactly one entry;
- plain address credentials (either encoding), never source-account credentials or delegated ones;
- for the account derived from the owner, and no other address.

`prepare`, `sign`, `relayRequest`, `simulateSigned` and `submitWith` all apply it, and `submitWith` derives the account from the owner again instead of trusting the one named in the call. Only contract calls are accepted: a host function that uploads code or creates a contract is refused.

`signedFromRelayRequest(request, network)` is the relayer's side of `relayRequest`: it reads a request back into a `Signed`, applying the same checks, and throws on anything else.

## Reading the chain

These simulate a read and need no account or fee:

- `usdcBalance(address, network)`: USDC held by a `G…` or `C…` address, in 7-decimal units.
- `ownerOf(account, network)`: the Ethereum address stored in an account contract, or `null` when nothing is deployed there.
- `isDeployed(owner, network)`: whether the owner's account contract exists yet.
- `readContract(contract, fn, args, network)`: any read-only contract function.

## Is the owner a key?

An account obeys one thing: a signature from the key of its owner address. An Ethereum address that is a contract (a Safe, a smart wallet) has no private key, so the Stellar account derived from it can receive USDC and never spend it. Nobody can tell the two apart by looking at the address.

```ts
import { ownerKind } from "paso-sdk";

const { kind, chains } = await ownerKind(owner);
// kind: "wallet" | "contract" | "unknown"
// chains: [{ name: "Ethereum", chainId: 1, code: "none" }, …]
```

`ownerKind(address, options)` asks every EVM chain the SDK lists, mainnet and testnet (`OWNER_CHAINS`, ten chains), for the code at the address, all at once and each for at most 6 seconds.

| `kind` | Meaning |
|---|---|
| `contract` | At least one chain has contract code at the address. Whatever is sent to its account stays there. |
| `unknown` | No chain has contract code there, and at least one failed or timed out. |
| `wallet` | Every chain answered and none has contract code. An EIP-7702 delegation (`0xef0100` and an address) counts as a wallet: the address still has its key. |

`wallet` means "no code found", not proof of a key. A smart account that has not been deployed yet has no code on any chain.

Options: `chains` (each `{ chain, rpcUrls }`; the endpoints are tried in order, the chain's public one when none is given), `timeoutMs`, `signal`, and `getCode(chain, address)` to read through your own client. A network failure never throws; it shows as `unknown`. `codeKind(code)` classifies one `eth_getCode` answer as `none`, `delegated` or `contract`.

## Showing the refusal

`withArgument(signed, index, value)` returns the signed call with one argument replaced in the call and in the authorisation entry alike, and the signature left as it was. It is the change a dishonest relayer or front end would have to make. The account rebuilds the signed text from what is about to run, so `simulateSigned` and any relayer refuse the result, and on chain the transaction fails with the account's `BadSignature` error.

`simulateSigned(signed)` checks a signed call against the network without submitting it. The account contract verifies the signature exactly as it would on submission, so it resolves only for a call the network would accept and throws a `SimulationError` for a wrong signer, a call that differs from what was signed, or an expired signature.

## Units

USDC has 6 decimals on every EVM chain listed and 7 on Stellar. Amounts are `bigint` in the units of the chain they are spent on: `fundFromEvm` takes 6-decimal units, actions take 7-decimal units.

On Arc gas is paid in USDC. The USDC token at `0x3600…0000` and the native balance are one balance: the token counts it in 6 decimals, the native balance in 18. CCTP burns and mints through the token, in 6 decimals as everywhere else, and a burn's gas comes out of the same USDC. `nativeUsdcToEvmUnits(wei)` and `evmUnitsToNativeUsdc(usdc6)` convert between the two.

`toStellarUnits(usdc6)` and `toEvmUnits(usdc7)` convert. `toEvmUnits` throws when the seventh decimal is not zero, and so does an `exit` with such an amount, before anything is signed. `parseStellarAmount`, `parseEvmAmount`, `formatStellarAmount` and `formatEvmAmount` convert to and from decimal text without rounding.

## Networks

`NETWORKS.testnet` pairs Stellar testnet with Circle's sandbox and five EVM test networks; `NETWORKS.mainnet` pairs Stellar mainnet with their mainnets. Base is the default chain, and `network.evm` is Base.

| Name | Testnet | Mainnet | CCTP domain | Gas | Towards Stellar |
|---|---|---|---|---|---|
| `base` | Base Sepolia (84532) | Base (8453) | 6 | ETH | fast transfer |
| `ethereum` | Ethereum Sepolia (11155111) | Ethereum (1) | 0 | ETH | fast transfer |
| `arbitrum` | Arbitrum Sepolia (421614) | Arbitrum (42161) | 3 | ETH | fast transfer |
| `optimism` | OP Sepolia (11155420) | OP Mainnet (10) | 2 | ETH | fast transfer |
| `arc` | Arc Testnet (5042002) | Arc (5042) | 26 | USDC | standard transfer, attested within seconds |

`evmChain(network, name)` returns one chain: its viem `chain`, `label`, `shortLabel`, `usdc`, `tokenMessenger`, `messageTransmitter`, `cctpDomain`, `usdcDecimals`, `gasToken`, public `rpcUrls`, `explorerUrl`, `fastTransfer` and, on testnet, `faucets`. A name it does not list throws. `listEvmChains(network)` lists them, Base first; `evmChainForDomain` and `evmChainForId` find one by CCTP domain or chain id. Every address was read back from its chain before it was listed, and so were Stellar's registrations of each chain; `test/fixtures/cctp-routes.json` holds what the chains said, and `pnpm routes --network <testnet|mainnet>` checks again.

Every function takes a network name or a `NetworkConfig`, so a custom RPC endpoint is a spread away:

```ts
const network = { ...NETWORKS.testnet, stellar: { ...NETWORKS.testnet.stellar, rpcUrl: "https://my-rpc.example" } };
```

Contract ids come from `deployments/<network>.json` at build time. Deriving an account on a network where the hub is not deployed throws. `stellarTxUrl`, `stellarAddressUrl`, `evmTxUrl(hash, network, chain?)` and `evmAddressUrl(address, network, chain?)` build explorer links; the EVM ones point at Base unless a chain is named.

`networkId(network)` is the 32-byte id that salts the signing domain, and `saltNetwork(salt)` goes the other way: `"testnet"`, `"mainnet"`, or `null` for any other salt. The salt is the only readable field of a signing request that says which network it is for, so show its name next to the wallet prompt.

## Limits

- Externally owned accounts only: a smart-contract wallet cannot produce the 65-byte signature the account checks, and USDC sent to the account of such an address cannot be moved again. `ownerKind` looks before you send.
- One signature covers one authorisation tree. A call that needs the account to authorise two unrelated trees is refused.
- Vec, Map and other nested values are bound by hash, not shown as text. `describeCalls` marks them as `hashed`.
- `prepare` keeps the validity of a signature to `MAX_VALIDITY_LEDGERS` at most. The account does not: a request built another way can carry any expiry, and the wallet prompt does not show it. The account has no function to revoke a signature before it expires.

## Develop

```sh
pnpm --filter paso-sdk test
pnpm --filter paso-sdk typecheck
pnpm --filter paso-sdk build
```

The tests reach Stellar testnet once the hub is deployed there; set `PASO_OFFLINE=1` to skip those. Two more are opt-in:

| Variable | Enables |
|---|---|
| `PASO_E2E_OWNER_KEY` | The private key of an Ethereum address whose account is deployed. Signs a transfer of nothing and checks that the account accepts it, then that it refuses the same signature on a changed call. Simulation only: no funds, nothing submitted. |
| `PASO_E2E_OWNER_KEY` and `PASO_E2E_SOURCE_SECRET` | Also submits a real 0.01 USDC transfer out of that account, paid for by the Stellar secret key. |
