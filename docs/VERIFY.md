# Check every claim in five minutes

Six steps. Steps 1 and 5 need a browser. Steps 2 and 4 need Node.js 22.12 or newer and pnpm. Step 3 needs Rust and the Stellar CLI. Step 6 is optional and needs a funded testnet account.

```sh
git clone https://github.com/RaYYeR220/paso
cd paso
pnpm install
```

`pnpm verify` and the Stellar CLI read the public Soroban RPC, which keeps about a week of transactions. The transactions below are from 2026-10-12. Once they have aged out, the explorer links still work and step 6 produces fresh ones.

## 1. Open the refused transaction and find the error

The claim: a signed call cannot be changed after signing.

Open two transactions on Stellar testnet, one ledger apart, from the same account:

- Accepted: <https://stellar.expert/explorer/testnet/tx/b8a81489a2b20babc3ceadf6c9b22ba15965c725a6594b3413de6c4aadc91ac5>
- Refused: <https://stellar.expert/explorer/testnet/tx/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181>

What to look for:

1. The first has status successful. The call is `approve` with the amount `1`.
2. The second has status failed. The call is the same `approve` with the amount `10000000000000`.
3. Both were paid for by the same Stellar account. The account that made the call is `CCI3…2VME` in both.

The explorer page shows the failure but not the contract's error code. Read it from the network's diagnostic events:

```sh
stellar tx fetch events --network testnet --output json-formatted \
  --hash ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181 \
  | grep -A 10 "failed account authentication"
```

Expected output:

```
                  "string": "failed account authentication with error"
                },
                {
                  "address": "CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME"
                },
                {
                  "error": {
                    "contract": 2
                  }
                }
              ]
```

Contract error 2 of the account is `BadSignature`: see `AccountError` in [`contracts/account/src/lib.rs`](../contracts/account/src/lib.rs).

Without the Stellar CLI, step 2 shows the same refusal from the other side.

## 2. Run `pnpm verify` on the example account's first call

The claim: a Stellar transaction was authorised by an Ethereum key, and anyone can check it from public chain data.

```sh
pnpm verify 43a92797a315f742ef121ec607e9d2ca23b68e10eb6d2ce931f5e7f7f0ad6d90
```

Expected output:

```
Transaction  43a92797a315f742ef121ec607e9d2ca23b68e10eb6d2ce931f5e7f7f0ad6d90
             https://stellar.expert/explorer/testnet/tx/43a92797a315f742ef121ec607e9d2ca23b68e10eb6d2ce931f5e7f7f0ad6d90
Status       SUCCESS, ledger 5159648
Fee paid by  GCWHW56HL2KP7ASCMWKP3GAO3HMUJ7XX6KH7S3PYALU6ZMZOCEP5VLRQ

Account      CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME
             https://stellar.expert/explorer/testnet/contract/CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME
Owner        0x7880DA9a52Af491f76421869d4e28DC0A4D1767C   (read from the account contract)

What the wallet showed (EIP-712, domain Paso v1, salt = network id)
  account   CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME
  call 1
    contract  CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
    fn        approve
    args[0]   CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME
    args[1]   CBNSNERNVI7NW7JWDLOFJQJYMJC67EMVZLQONBBPWR4HLQMP53QGFOBO
    args[2]   1
    args[3]   5159846
  payload   0x57246257bd3aa74bb65b3bfdfdfd7d2093286f6d309e8df1f60d3d11b0f1f3e7

Digest       0xfc4623691cc7ce8a8104ed462f05dd5ad26af83865f63f7d2ed69710402f130f
Signature    0xa669743b0aa24ba0f94be7ee1953cd73597c5642ab7ff62d8aa6c92ae51b13742d956a2f52846645f80379c8f13398458e6a0befaeffca107b1ed32f517eef8b1b
Signer       0x7880DA9a52Af491f76421869d4e28DC0A4D1767C   (recovered from the signature over that digest)

Checks
  PASS  the signer is the owner stored in the account
        recovered 0x7880DA9a52Af491f76421869d4e28DC0A4D1767C, owner() 0x7880DA9a52Af491f76421869d4e28DC0A4D1767C
  PASS  the account is the address derived from the owner
        twinAddress(0x7880DA9a52Af491f76421869d4e28DC0A4D1767C) = CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME
  PASS  the account runs the published account code
        wasm 2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee

Verified.
```

The exit code is 0.

How to read it:

- **Fee paid by** is a `G…` account. It is not the owner and not the account.
- **What the wallet showed** is rebuilt by the script from the transaction's authorisation entry. The script is [`scripts/verify.ts`](../scripts/verify.ts), about 190 lines.
- **Signer** is recovered from the 65-byte signature inside the transaction. It equals the owner that the account contract returns from `owner()`.
- The second check derives the account address from the owner off chain and compares it with the address on chain.
- The third check compares the code hash of the account on chain with `accountWasmHash` in [`deployments/testnet.json`](../deployments/testnet.json).

Now the refused transaction:

```sh
pnpm verify ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181
```

The message is rebuilt from the call that was submitted, with `args[2]   10000000000000`. The signature in the transaction was made for `1`, so it recovers to an address that is not the owner. The output ends with:

```
Checks
  FAIL  the signer is the owner stored in the account
        recovered 0x5c754C41E30Fd646140fD7EaB8E896F01b37936e, owner() 0x7880DA9a52Af491f76421869d4e28DC0A4D1767C
  PASS  the account is the address derived from the owner
        twinAddress(0x7880DA9a52Af491f76421869d4e28DC0A4D1767C) = CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME
  PASS  the account runs the published account code
        wasm 2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee

The transaction failed on chain, as it must: the signature does not cover the calls it tried to run.

NOT verified.
```

The exit code is 1.

Two more to try. Both exit 0:

```sh
# A USDC transfer to the account of another Ethereum address
pnpm verify dc3db1dd76496889c53a0007d3017e6b0d8019848c4ebbe555f9899b76eadf63

# The exit to Base: one signature, two calls (hub.exit and the nested USDC transfer)
pnpm verify 6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f
```

## 3. Run the contract tests

The claim: 29 tests for the account contract and 15 for the hub pass.

```sh
pnpm test:contracts
```

This runs `stellar contract build` and then `cargo test`. Expected lines:

```
test result: ok. 29 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Tests worth reading in [`contracts/account/src/test.rs`](../contracts/account/src/test.rs):

| Test | What it shows |
|---|---|
| `digest_matches_every_vector`, `accepts_every_vector` | The contract computes the digests in `fixtures/vectors.json` and accepts their signatures. |
| `rejects_changed_argument`, `rejects_added_call`, `rejects_reordered_calls` | Any change to the calls is refused. |
| `rejects_other_account`, `rejects_other_network` | A signature does not carry over. |
| `rejects_high_s`, `rejects_v_2` | Malleable and malformed signatures are refused. |
| `host_lists_contexts_root_first_then_depth_first` | The call order, through the host's own authorisation path. |

And in [`contracts/hub/src/test.rs`](../contracts/hub/src/test.rs): `address_matches_the_off_chain_derivation`, `receives_before_it_is_deployed`, `twin_refuses_an_exit_that_differs_from_what_was_shown`.

The build also lets you check the account code. The hash of your build should be the one deployed:

```sh
shasum -a 256 target/wasm32v1-none/release/paso_account.wasm
# 2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee
```

The hash matches with Rust 1.99.0 and Stellar CLI 28.1.0. Another compiler version can produce different bytes.

## 4. Derive an account for any address

The claim: every Ethereum address already has a Stellar account, and the address is computed with no network call.

Save this as `derive.mts` in the repository root:

```ts
import { formatStellarAmount, isDeployed, ownerOf, twinAddress, usdcBalance } from "./packages/sdk/src/index";

const owner = process.argv[2] as `0x${string}`;
const account = twinAddress(owner, "testnet"); // pure: no network call

console.log("account ", account);
console.log("deployed", await isDeployed(owner, "testnet"));
console.log("owner() ", await ownerOf(account, "testnet"));
console.log("USDC    ", formatStellarAmount(await usdcBalance(account, "testnet")));
```

Run it for the example owner:

```sh
pnpm exec tsx derive.mts 0x7880DA9a52Af491f76421869d4e28DC0A4D1767C
```

```
account  CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME
deployed true
owner()  0x7880DA9a52Af491f76421869d4e28DC0A4D1767C
USDC     0.39987
```

The first line needs no network. The other three read testnet. `owner()` is read back from the contract at the derived address, and it is the address you started from. The balance was 0.39987 on 2026-10-12 and changes if the account is used.

Run it for an address that never deployed its account:

```sh
pnpm exec tsx derive.mts 0xC801b29BC8eE267cA2C353fF146FFa642Cc2BE85
```

```
account  CAT44DMN6RQ44HZDEBJUSBWRJ3YOICUNPFHYIG6FSEUWFEBUYWIVY7FJ
deployed false
owner()  null
USDC     0.1
```

It holds 0.1 USDC with no contract deployed. Anyone may deploy that account, so `deployed` can change.

Run it for your own address. The account is yours as soon as the address is printed.

`pnpm test:sdk` also checks, for three addresses, that `twinAddress` equals what `hub.address_of` returns on chain.

## 5. Follow one dollar across both chains

The claim: USDC went from Base Sepolia into the account and back, with the Ethereum key as the only authority on the Stellar side.

| Time (UTC) | Step | Link |
|---|---|---|
| 17:10:58 | 1 USDC burned on Base Sepolia | <https://sepolia.basescan.org/tx/0x43c00d27bf35c2288c160e6e1bfad424a206dc0e0b2d0ae901e7b20a88879b9e> |
| 17:11:07 | Delivered on Stellar: 0.99987 USDC to the account | <https://stellar.expert/explorer/testnet/tx/f7c95418993326f42b05c8a682e9dc3a9a7e18d0ad267b168eba09b1a40d23f1> |
| 17:11:12 | 0.1 USDC to the account of `0xC801b29BC8eE267cA2C353fF146FFa642Cc2BE85` | <https://stellar.expert/explorer/testnet/tx/dc3db1dd76496889c53a0007d3017e6b0d8019848c4ebbe555f9899b76eadf63> |
| 17:11:17 | 0.5 USDC burned on Stellar by `hub.exit` | <https://stellar.expert/explorer/testnet/tx/6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f> |
| 17:11:30 | 0.5 USDC minted on Base Sepolia to `0x7880DA9a52Af491f76421869d4e28DC0A4D1767C` | <https://sepolia.basescan.org/tx/0xd81b8b7e8f762910712494e3fba1b29144f2cef41a27081c44adb820ee5b137d> |

Things to check on those pages:

- The burn on Base was sent by `0xEe67130Fa530c04b88D6Fd99fcc7D1D1494841f8`, a separate payer. The payer does not have to be the owner.
- The delivery carries no signature from the owner. Delivering a CCTP message is permissionless. `pnpm verify` on that hash reports `No authorisation by a Paso account in this transaction`, which is correct.
- The transfer and the exit each pass step 2.
- 0.99987 in, 0.1 and 0.5 out, 0.39987 left: the balance from step 4.

Circle's own record of the two burns:

```sh
curl -s "https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=0x43c00d27bf35c2288c160e6e1bfad424a206dc0e0b2d0ae901e7b20a88879b9e" | grep -o '"status":"[a-z_]*"'
curl -s "https://iris-api-sandbox.circle.com/v2/messages/27?transactionHash=6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f" | grep -o '"status":"[a-z_]*"'
```

Both print `"status":"complete"`. `6` is the CCTP domain of Base and `27` is Stellar's.

## 6. Optional: make your own refusal

The claim: none of the above depends on the transactions already on chain, or on a particular relayer.

```sh
stellar keys generate paso-check --network testnet --fund
PASO_E2E_SOURCE_SECRET=$(stellar keys secret paso-check) pnpm e2e --stellar-only
```

The script takes a fresh Ethereum key and prints every step with its explorer link:

1. It derives the account, deploys it and makes a first call: a USDC `approve` for amount `1`, signed with the Ethereum key.
2. It signs the same call again, replaces the amount with `10000000000000`, and shows the network refusing it twice: in simulation, and on chain as a failed transaction.

The second part ends like this, with your own account and hashes:

```
[2] The same signature over a different amount
    signed     CBIE…DAMA.approve(<account>, CBNS…FOBO, 1, <ledger>)
    submitted  CBIE…DAMA.approve(<account>, CBNS…FOBO, 10000000000000, <ledger>)
    simulation refused, account answered Error(Contract, #2)
    on chain   <hash>  FAILED
    result     txFailed, invokeHostFunctionTrapped
    cause      __check_auth of <account> returned Error(Contract, #2)
               BadSignature: the call that ran is not the call that was signed
    host log   ["failed account authentication with error", <account>, Error(Contract, #2)]

Done.
```

Your key pays the fees. No relayer is involved.

## What these steps do not show

- That the code is free of bugs. It is unaudited.
- That a browser wallet displays the message well. The signatures above were made by scripts.
- Anything about mainnet. Nothing is deployed there.

[CLAIMS.md](CLAIMS.md) has the full list of what is and is not claimed.
