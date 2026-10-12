# @paso/sdk

Every Ethereum address already has a Stellar account. This package finds it, funds it from Base and lets the same Ethereum key control it.

- **Derive.** `twinAddress(owner, network)` returns the Stellar contract account (`C…`) of an Ethereum address. It is pure arithmetic: the account can receive USDC before it is deployed.
- **Fund.** `fundFromEvm` burns USDC on Base through Circle's CCTP; `waitForAttestation` follows the transfer until it can be delivered on Stellar.
- **Act.** `prepare` simulates a transfer, a withdrawal back to Base, or any contract call, and returns EIP-712 typed data. `sign` asks the wallet. `relay` hands the result to a relayer that pays the fee, or `submitWith` sends it from any funded Stellar account.

The wallet shows the real calls: contract, function and every argument as text. The account contract rebuilds that same text from what is about to execute and rejects the signature if anything differs.

## Usage

```ts
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { baseSepolia } from "viem/chains";
import { fundFromEvm, parseStellarAmount, prepare, relay, sign, twinAddress, waitForAttestation } from "@paso/sdk";

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

`sign` accepts a viem account or a wallet client that has its account set. For a wallet client without one, wrap it: `{ signTypedData: (data) => walletClient.signTypedData({ ...data, account }) }`.

## Actions

| Action | What runs on Stellar |
|---|---|
| `{ kind: "transfer", to, amount }` | USDC `transfer(account, to, amount)`. `to` is `G…`, `C…`, or `0x…` for the Stellar account of that Ethereum address. |
| `{ kind: "exit", amount, recipient }` | `hub.exit(account, amount, domain, recipient, max_fee, min_finality_threshold)`: USDC leaves for `recipient` on Base. Optional `destinationDomain`, `maxFee`, `minFinalityThreshold`. |
| `{ kind: "invoke", contract, fn, args }` | Any contract function that asks the account for authorisation. |

`prepare(action, { owner, network })` returns plain JSON: `{ network, owner, account, txXdr, entries, typedData, calls, validUntilLedger }`. The signature is accepted up to and including `validUntilLedger` (about ten minutes by default; set `validForLedgers` to change it). `isExpired(prepared, latestLedger)` tells when to prepare again.

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

## Funding from Base

`fundFromEvm({ walletClient, publicClient, amount, owner, network, route })` approves Circle's TokenMessenger when the allowance is short, then burns with a fast transfer. `amount` is in 6-decimal units; the payer need not be the owner.

| `route` | Burn on Base | Delivery on Stellar |
|---|---|---|
| `"forwarder"` (default) | `depositForBurnWithHook`, mint recipient and destination caller set to Circle's CctpForwarder, the account named in the hook data | `mintAndForwardOperation(message, attestation, network)` |
| `"direct"` | `depositForBurn`, mint recipient set to the account's contract id, no destination caller | `receiveMessageOperation(caller, message, attestation, network)` |

`waitForAttestation(sourceDomain, txHash, network, { signal, onStatus })` polls Circle's Iris service until the burn is attested and resolves to `{ message, attestation, nonce }`. It reports `not_found`, `pending`, `unreachable` and `complete` through `onStatus` and keeps polling until aborted. `deliverOperation({ message, attestation, caller }, network)` picks the right delivery call from the message itself.

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
- `auth`: every authorisation entry the call needs, in order, with the owner's signature attached.

The relayer answers `200` with `{ "hash": "<transaction hash>" }`, or a non-2xx status with `{ "error": "expired" | "bad_signature" | "simulation_failed", "detail": "…" }`. `relay` throws a `RelayError` carrying that `error` as `code`; on `expired`, prepare and sign again.

A relayer builds its own transaction around `func` and `auth` and pays the fee. It can decline. It cannot change the call or its arguments: the signature covers them. The types are exported as `RelayRequest` and `RelayResponse`, and `relayRequest(signed)` builds the body.

Without a relayer, `submitWith(signed, keypair)` does the same from any funded Stellar account, deploying the owner's account first if it does not exist.

## Units

USDC has 6 decimals on Base and 7 on Stellar. Amounts are `bigint` in the units of the chain they are spent on: `fundFromEvm` takes 6-decimal units, actions take 7-decimal units.

`toStellarUnits(usdc6)` and `toEvmUnits(usdc7)` convert. `toEvmUnits` throws when the seventh decimal is not zero, and so does an `exit` with such an amount, before anything is signed. `parseStellarAmount`, `parseEvmAmount`, `formatStellarAmount` and `formatEvmAmount` convert to and from decimal text without rounding.

## Networks

`NETWORKS.testnet` pairs Stellar testnet with Base Sepolia and Circle's sandbox; `NETWORKS.mainnet` pairs Stellar mainnet with Base. Every function takes a network name or a `NetworkConfig`, so a custom RPC endpoint is a spread away:

```ts
const network = { ...NETWORKS.testnet, stellar: { ...NETWORKS.testnet.stellar, rpcUrl: "https://my-rpc.example" } };
```

Contract ids come from `deployments/<network>.json` at build time. Deriving an account on a network where the hub is not deployed throws. `stellarTxUrl`, `stellarAddressUrl`, `evmTxUrl` and `evmAddressUrl` build explorer links.

## Limits

- Externally owned accounts only: a smart-contract wallet cannot produce the 65-byte signature the account checks.
- One signature covers one authorisation tree. A call that needs the account to authorise two unrelated trees is refused.
- Vec, Map and other nested values are bound by hash, not shown as text.

## Develop

```sh
pnpm --filter @paso/sdk test        # unit tests; tests against the testnet hub run once it is deployed
pnpm --filter @paso/sdk typecheck
pnpm --filter @paso/sdk build
```

Set `PASO_OFFLINE=1` to skip the tests that reach the network.
