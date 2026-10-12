# Claims

Every public claim Paso makes, with its evidence. Checked on 2026-10-12 against Stellar testnet and Base Sepolia.

| Tag | Meaning |
|---|---|
| `REPRODUCIBLE` | A command anyone can run. The expected result is stated. |
| `VERIFIED LIVE` | A transaction on a public network, linked. |
| `BUILT, NOT RUN LIVE` | Code and tests exist. No live transaction is recorded. |
| `NOT CLAIMED` | Not done, or not asserted. |

Commands assume a clone with `pnpm install` done. `pnpm verify` and `stellar tx fetch` read the public Soroban RPC, which keeps about a week of transactions; explorer links outlive that. Step numbers refer to [VERIFY.md](VERIFY.md).

Identifiers used below:

| | |
|---|---|
| Hub | [`CBNSNERNVI7NW7JWDLOFJQJYMJC67EMVZLQONBBPWR4HLQMP53QGFOBO`](https://stellar.expert/explorer/testnet/contract/CBNSNERNVI7NW7JWDLOFJQJYMJC67EMVZLQONBBPWR4HLQMP53QGFOBO) |
| Example owner | `0x7880DA9a52Af491f76421869d4e28DC0A4D1767C` |
| Example account | [`CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME`](https://stellar.expert/explorer/testnet/contract/CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME) |
| Fee payer in every linked Stellar transaction | `GCWHW56HL2KP7ASCMWKP3GAO3HMUJ7XX6KH7S3PYALU6ZMZOCEP5VLRQ` |

## The account

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 1 | Every Ethereum address has a Stellar account address, computed with no network call. | `REPRODUCIBLE` | Step 4. Hub test `address_matches_the_off_chain_derivation`. `pnpm test:sdk` compares `twinAddress` with `hub.address_of` on testnet for three addresses. The address depends on the hub: a different hub gives different addresses (`address_depends_on_the_hub`). |
| 2 | The hub is deployed on Stellar testnet. | `VERIFIED LIVE` | Deploy [`fdacf6ee…`](https://stellar.expert/explorer/testnet/tx/fdacf6ee2c1b428ab4d5773070ec2270036d3939865c6b01b902e83ad7d44b45). Code upload [`cb039f10…`](https://stellar.expert/explorer/testnet/tx/cb039f10a642650601f91101d1ee1d388edad529071b2b61ac8dc351bc83f652). |
| 3 | The account code has wasm hash `2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee` and is 7,837 bytes. The hub is 4,156 bytes. | `VERIFIED LIVE`, `REPRODUCIBLE` | Upload [`2d6baec6…`](https://stellar.expert/explorer/testnet/tx/2d6baec6ecf690266226141fe1a0bf747f58978be3537180416722180dfec96d). `pnpm build:contracts`, then `shasum -a 256 target/wasm32v1-none/release/paso_account.wasm`. The hash is reproduced with Rust 1.99.0 and Stellar CLI 28.1.0. `rust-toolchain.toml` names the `stable` channel, not a version, so another compiler can produce different bytes. |
| 4 | Anyone can deploy an account, and deploying twice changes nothing. | `VERIFIED LIVE` | First [`e5fe8370…`](https://stellar.expert/explorer/testnet/tx/e5fe8370b67f0ba7d9e1f24f108824e3ecacad72663e73ffb03e79798a4050b4), second [`b1e88787…`](https://stellar.expert/explorer/testnet/tx/b1e8878740ee55801bcdaddd5b8985acb29024212f1ac8f0134ad2735ec455b3). Hub tests `deploy_is_idempotent`, `deploy_needs_no_authorization`. |
| 5 | An account can only be created with the owner its address was derived from. | `REPRODUCIBLE` | `deploy` in `contracts/hub/src/lib.rs` uses the owner as salt and as constructor argument. Hub test `deployed_account_has_owner`. |
| 6 | The contracts have no administrator, no upgrade function and no way to change an owner. | `REPRODUCIBLE` | Read `contracts/account/src/lib.rs` (three functions) and `contracts/hub/src/lib.rs` (four functions). |

## The signature

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 7 | A Stellar contract call was authorised by an Ethereum signature. | `VERIFIED LIVE`, `REPRODUCIBLE` | [`43a92797…`](https://stellar.expert/explorer/testnet/tx/43a92797a315f742ef121ec607e9d2ca23b68e10eb6d2ce931f5e7f7f0ad6d90), SUCCESS, ledger 5159648. `pnpm verify 43a92797a315f742ef121ec607e9d2ca23b68e10eb6d2ce931f5e7f7f0ad6d90` exits 0. The signature was made by a script holding the key, not by a browser wallet. |
| 8 | The signed message is rebuilt on chain from the calls being authorised. A call changed after signing is refused. | `VERIFIED LIVE`, `REPRODUCIBLE` | [`ded23530…`](https://stellar.expert/explorer/testnet/tx/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181), FAILED, ledger 5160302, `txFailed, invokeHostFunctionTrapped`, host log `["failed account authentication with error", CCI3UVOB…OH2VME, Error(Contract, #2)]`. Earlier ones: [`32a1c98d…`](https://stellar.expert/explorer/testnet/tx/32a1c98dd9f14ffcae41448cdacd525f5f76b073aa695cc9a3c018bd56ade1b3), [`e8a91143…`](https://stellar.expert/explorer/testnet/tx/e8a91143725b27bdd36fd997b6262d3196048e0edf4793e9bbf5c388bc0e9d7a). Step 1 prints the error; `pnpm verify` on any of the three exits 1. Account tests `rejects_changed_argument`, `rejects_changed_recipient`, `rejects_changed_contract_or_function`, `rejects_added_call`, `rejects_removed_call`, `rejects_reordered_calls`. Step 6 makes a new one. These transactions were built to fail and submitted on purpose; no relayer sends them. |
| 9 | The message that is signed lists exactly the calls that execute. | `REPRODUCIBLE` | Rows 7 and 8, and [ENCODING.md](ENCODING.md). This is a claim about the EIP-712 message. How a wallet lays it out on screen is not claimed; see row 37. |
| 10 | A signature is valid for one account, on one network, once, until its expiry. | `REPRODUCIBLE` | Account tests `rejects_other_account`, `rejects_other_network`, `rejects_other_payload`. Hub test `twin_signature_cannot_be_replayed_or_stretched`. Nonce and expiry are enforced by the Soroban host, not by Paso's code. |
| 11 | One signature covers a call and the calls nested in it. | `VERIFIED LIVE` | Exit [`6cae28f1…`](https://stellar.expert/explorer/testnet/tx/6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f): `hub.exit` and the nested USDC `transfer`. `pnpm verify` on it prints both calls. Hub test `twin_exits_with_one_ethereum_signature`. |
| 12 | Calls are listed root first, then sub-calls depth first, and that is the order the host uses. | `REPRODUCIBLE` | Account test `host_lists_contexts_root_first_then_depth_first`, which goes through the host's own authorisation path. |
| 13 | The Rust contract and the TypeScript SDK agree on 11 signing vectors: text, digest and recovered signer. | `REPRODUCIBLE` | `pnpm test:contracts` and `pnpm test:sdk`. The vectors use stand-in payloads and test addresses. Building the payload from a real entry is covered by the SDK's testnet tests and by the live transactions. |
| 14 | Malleable and malformed signatures are refused. | `REPRODUCIBLE` | Account tests `rejects_high_s`, `rejects_out_of_range_r_and_s`, `rejects_v_2`, `rejects_flipped_recovery_id`, `rejects_signature_of_the_wrong_length`, `never_accepts_an_arbitrary_r`. An `r` that is not a curve point aborts in the host rather than returning a typed error. |

## Fees and the relayer

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 15 | The owner needs no XLM. A separate account paid the fee of every call. | `VERIFIED LIVE` | Every linked Stellar transaction has the source account `GCWHW56H…P5VLRQ`. `pnpm verify` prints it as `Fee paid by`. |
| 16 | The account holds USDC with no trustline. | `VERIFIED LIVE` | Delivery [`f7c95418…`](https://stellar.expert/explorer/testnet/tx/f7c95418993326f42b05c8a682e9dc3a9a7e18d0ad267b168eba09b1a40d23f1) credits a contract address. A contract address has no trustlines; the USDC contract keeps its balance. Step 4 reads it. |
| 17 | The relayer API deployed an account and relayed a signed call, paying both fees. | `VERIFIED LIVE` | Deploy [`0ec43de4…`](https://stellar.expert/explorer/testnet/tx/0ec43de437e650f7db5aa8bf942bf2f7460a168020f17ddfceae7c9f51febda9), call [`5a6cf2ec…`](https://stellar.expert/explorer/testnet/tx/5a6cf2ece6050bcd5d96d59b71162f1de514119ae8acbc99adbcbc37158bb890), SUCCESS, ledger 5160022. The relayed transaction has one operation and one authorisation entry. |
| 18 | For a relayed call the relayer attaches one authorisation entry, for the owner's account, on a contract invocation, under a fee cap. | `REPRODUCIBLE` | `apps/web/lib/server/relayer.ts` and `assertOnlyAccountEntries` in `packages/sdk/src/auth.ts`. `PASO_OFFLINE=1 pnpm test:web` runs the offline part, including the fee cap and the daily budget. The tests that try to borrow the relayer's authority on testnet are in `apps/web/test/relay.test.ts` and need `RELAYER_SECRET` and `PASO_E2E_OWNER_KEY`. |
| 19 | A fee payer cannot change a signed call or move the owner's funds. | `REPRODUCIBLE` | Row 8: the account refuses any change. A fee payer holds no key of the account. |
| 20 | Anyone can submit instead of the relayer. | `REPRODUCIBLE` | Step 6 runs with your own funded account and no relayer. In the run of rows 22 to 27 the Stellar transactions were submitted by `scripts/e2e.ts` through the SDK. |
| 21 | Fees charged: deploy 0.010577 XLM, `approve` 0.0020918, CCTP delivery 0.0756425, USDC transfer to an address with no balance 0.0633319, exit 0.0659997. | `VERIFIED LIVE` | "Fee charged" on [`0ec43de4…`](https://stellar.expert/explorer/testnet/tx/0ec43de437e650f7db5aa8bf942bf2f7460a168020f17ddfceae7c9f51febda9), [`5a6cf2ec…`](https://stellar.expert/explorer/testnet/tx/5a6cf2ece6050bcd5d96d59b71162f1de514119ae8acbc99adbcbc37158bb890), [`f7c95418…`](https://stellar.expert/explorer/testnet/tx/f7c95418993326f42b05c8a682e9dc3a9a7e18d0ad267b168eba09b1a40d23f1), [`dc3db1dd…`](https://stellar.expert/explorer/testnet/tx/dc3db1dd76496889c53a0007d3017e6b0d8019848c4ebbe555f9899b76eadf63), [`6cae28f1…`](https://stellar.expert/explorer/testnet/tx/6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f). Testnet fees, one sample each. |

## Across chains

One run on 2026-10-12, for the example owner. Times are block and ledger close times, UTC.

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 22 | 1 USDC was burned on Base Sepolia for the owner's Stellar account, through Circle's CctpForwarder route as a Fast Transfer. | `VERIFIED LIVE` | Approval [`0x488a7aa0…`](https://sepolia.basescan.org/tx/0x488a7aa038e69448b0cc83701b3dd4295904400a4622df64f5d18f48653cab4b), burn [`0x43c00d27…`](https://sepolia.basescan.org/tx/0x43c00d27bf35c2288c160e6e1bfad424a206dc0e0b2d0ae901e7b20a88879b9e) at 17:10:58. Both were sent by `0xEe67130Fa530c04b88D6Fd99fcc7D1D1494841f8`, a separate payer, not by the owner's address. |
| 23 | The USDC arrived in the account on Stellar: 0.99987 USDC, with 0.00013 kept by Circle. | `VERIFIED LIVE` | Delivery [`f7c95418…`](https://stellar.expert/explorer/testnet/tx/f7c95418993326f42b05c8a682e9dc3a9a7e18d0ad267b168eba09b1a40d23f1) at 17:11:07, nine seconds after the burn's block. It calls Circle's CctpForwarder and carries no authorisation entry. Step 5 queries Circle's record. The attestation time of 7 seconds was measured by the script that ran it. |
| 24 | An Ethereum address was paid on Stellar before it had an account. | `VERIFIED LIVE`, `REPRODUCIBLE` | Transfer [`dc3db1dd…`](https://stellar.expert/explorer/testnet/tx/dc3db1dd76496889c53a0007d3017e6b0d8019848c4ebbe555f9899b76eadf63) at 17:11:12: 0.1 USDC to `CAT44DMN6RQ44HZDEBJUSBWRJ3YOICUNPFHYIG6FSEUWFEBUYWIVY7FJ`, the account of `0xC801b29BC8eE267cA2C353fF146FFa642Cc2BE85`. Step 4 shows it undeployed and holding 0.1. Hub test `receives_before_it_is_deployed`. |
| 25 | USDC went back to Base with one signature. | `VERIFIED LIVE` | Exit [`6cae28f1…`](https://stellar.expert/explorer/testnet/tx/6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f) at 17:11:17: 0.5 USDC, fee cap 0, Fast Transfer. Mint on Base Sepolia [`0xd81b8b7e…`](https://sepolia.basescan.org/tx/0xd81b8b7e8f762910712494e3fba1b29144f2cef41a27081c44adb820ee5b137d) at 17:11:30, to the owner's address. The mint was submitted by the payer of row 22; anyone may submit it. The attestation time of 9 seconds was measured by the script. |
| 26 | From the burn on Base to the mint back on Base: 32 seconds. | `VERIFIED LIVE` | Block times of the burn and the mint in rows 22 and 25. One run. |
| 27 | In that run the owner's key signed three calls and one more that was changed and refused. | `VERIFIED LIVE` | Transfer and exit above, `approve` [`b8a81489…`](https://stellar.expert/explorer/testnet/tx/b8a81489a2b20babc3ceadf6c9b22ba15965c725a6594b3413de6c4aadc91ac5), refusal in row 8. On Base the owner's key signed nothing. |
| 28 | Incoming USDC uses Circle's contracts only. Paso adds no bridge contract for it. | `VERIFIED LIVE` | Row 23. The contracts called are Circle's CctpForwarder, MessageTransmitter and TokenMessengerMinter. |
| 29 | The relayer's `/api/cctp/deliver` route delivers an attested burn. | `BUILT, NOT RUN LIVE` | `apps/web/test/deliver.test.ts`. The live delivery in row 23 was submitted through the SDK's `deliverWith`. |
| 30 | The testnet faucet route `/api/demo/fund` burns 1 test USDC for an owner. | `BUILT, NOT RUN LIVE` | `apps/web/test/fund.test.ts`. |
| 31 | The direct inbound route: mint straight to the account's contract id through `receive_message`. | `BUILT, NOT RUN LIVE` | `route: "direct"` in `packages/sdk/src/evm.ts`. The live run used the forwarder route. |
| 32 | Standard finality transfers, and a non-zero fee cap on exit. | `BUILT, NOT RUN LIVE` | Options of `fundFromEvm` and of the `exit` action. Both live transfers were Fast Transfers; the exit ran with a fee cap of 0. |
| 33 | `hub.exit` against Circle's TokenMessengerMinter. | `VERIFIED LIVE` | Row 25, once. The hub's unit tests use a stand-in for Circle's contract. |

## Tests

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 34 | 29 account tests and 15 hub tests pass. | `REPRODUCIBLE` | `pnpm test:contracts`. Step 3. |
| 35 | 189 SDK tests pass. | `REPRODUCIBLE` | `pnpm test:sdk`. It reads Stellar testnet. `PASO_OFFLINE=1 pnpm test:sdk` runs 181. With `PASO_E2E_OWNER_KEY` set it runs 190. One more test moves USDC and needs a funded account and a fee payer. |
| 36 | 87 relayer tests pass offline. | `REPRODUCIBLE` | `PASO_OFFLINE=1 pnpm test:web`. 21 more send testnet transactions and need `RELAYER_SECRET` and `PASO_E2E_OWNER_KEY`. |

## Wallets

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 37 | A browser wallet signs this message through `eth_signTypedData_v4`. | `BUILT, NOT RUN LIVE` | `sign` in the SDK takes a viem account or wallet client. Every signature in the linked transactions was made by a script through viem's EIP-712 signer with the key in memory. No browser wallet session is recorded. |

## Not claimed

- **Audited.** There is no audit and no formal verification.
- **Mainnet.** Nothing is deployed there. The SDK carries Circle's mainnet contract ids and an empty hub id; deriving an account on mainnet throws.
- **A hosted site.** None is claimed here.
- **Other source chains.** Only Base Sepolia has been used. Other CCTP chains are untested.
- **Key recovery or rotation.** A lost Ethereum key is a lost account.
- **Smart-contract wallets.** ERC-1271 signatures are not accepted. Neither are passkeys or multisig.
- **"First".** Paso does not claim to be the first at any part of this. See prior art below.
- **A readable message for every call.** Nested arguments appear as hashes. Amounts are raw integers and contracts are addresses. The signature's expiry is not displayed.
- **Tested wallets.** No specific wallet, browser or hardware, has been tested.
- **A verified build.** The check in `pnpm verify` compares the code hash on chain with a hash recorded in this repository. No third-party build attestation is published.
- **A decentralised or always-on relayer.** It is one server with in-memory limits. It can decline. The fallback is to submit from any funded account.
- **Long-lived accounts.** Every account here is hours old. The contracts never extend TTLs, and restoring an archived account has not been exercised.
- **Mainnet costs.** The fees in row 21 are testnet samples.
- **Load.** No load test has been run.
- **A published package.** `@paso/sdk` is not on npm.
- **Privacy.** Owner addresses, account addresses and calls are public.

## Statements about other projects

These come from those projects' public material and are not verified by anything in this repository.

- MetaMask's Stellar support creates a classic account that needs 1 XLM plus 0.5 XLM per trustline, in MetaMask only.
- EIP-712 verification inside a Soroban `__check_auth` exists in LayerZero's OneSig multisig for Stellar.
- OpenZeppelin's Stellar smart accounts ship ed25519 and WebAuthn verifiers.

Paso's part is narrower: an account derived from the Ethereum address itself, with the displayed message rebuilt on chain from the calls being authorised.
