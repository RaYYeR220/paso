# Claims

Every public claim Paso makes, with its evidence. Checked on 2026-10-12 against Stellar mainnet and testnet, Base and Base Sepolia.

| Tag | Meaning |
|---|---|
| `REPRODUCIBLE` | A command anyone can run. The expected result is stated. |
| `VERIFIED LIVE` | A transaction on a public network, linked. |
| `BUILT, NOT RUN LIVE` | Code and tests exist. No live transaction is recorded. |
| `NOT CLAIMED` | Not done, or not asserted. |

Commands assume a clone with `pnpm install` done. `pnpm verify` and `stellar tx fetch` read a public Soroban RPC, which keeps about a week of transactions; explorer links outlive that. Step numbers refer to [VERIFY.md](VERIFY.md).

Identifiers used below:

| | Mainnet | Testnet |
|---|---|---|
| Hub | [`CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK`](https://stellar.expert/explorer/public/contract/CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK) | [`CBNSNERNVI7NW7JWDLOFJQJYMJC67EMVZLQONBBPWR4HLQMP53QGFOBO`](https://stellar.expert/explorer/testnet/contract/CBNSNERNVI7NW7JWDLOFJQJYMJC67EMVZLQONBBPWR4HLQMP53QGFOBO) |
| Example owner | `0x20806157d9607050204bbbCd37CE71498B35D46c` | `0x7880DA9a52Af491f76421869d4e28DC0A4D1767C` |
| Its account | [`CBWU43NDIBPC6SD2WKVNJH6A5ROHGMSDJWAVLCO3RITO5Q264XEZ7EPX`](https://stellar.expert/explorer/public/contract/CBWU43NDIBPC6SD2WKVNJH6A5ROHGMSDJWAVLCO3RITO5Q264XEZ7EPX) | [`CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME`](https://stellar.expert/explorer/testnet/contract/CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME) |
| Fee payer of every linked Stellar transaction | `GAS65I36DQSMBSEZRN5KXDJMRCNEWNEX2VANOQB2QZQX5JX2X6D4SQBM` | `GCWHW56HL2KP7ASCMWKP3GAO3HMUJ7XX6KH7S3PYALU6ZMZOCEP5VLRQ` |

## The account

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 1 | Every Ethereum address has a Stellar account address, computed with no network call. | `REPRODUCIBLE` | Step 4. Hub test `address_matches_the_off_chain_derivation`. `pnpm test:sdk` compares `twinAddress` with `hub.address_of` on testnet for three addresses. The address depends on the network and on the hub (`address_depends_on_the_hub`), so an owner's mainnet and testnet addresses differ. |
| 2 | The hub is deployed on Stellar mainnet and on testnet. | `VERIFIED LIVE` | Mainnet: deployed in [`9285fcdb…`](https://stellar.expert/explorer/public/tx/9285fcdb5d3f065c196816810ff6af1ff453ece88824e5775bd4602154082426), hub code uploaded in [`c3eca151…`](https://stellar.expert/explorer/public/tx/c3eca151541a5e66d2d7679a37492686cd5dd46a1c5f7c66c1f9f8bcb6139161). Testnet: deployed in [`fdacf6ee…`](https://stellar.expert/explorer/testnet/tx/fdacf6ee2c1b428ab4d5773070ec2270036d3939865c6b01b902e83ad7d44b45), code uploaded in [`cb039f10…`](https://stellar.expert/explorer/testnet/tx/cb039f10a642650601f91101d1ee1d388edad529071b2b61ac8dc351bc83f652). |
| 3 | Both networks run the same account code: wasm hash `2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee`, 7,837 bytes. The hub is 4,156 bytes. | `VERIFIED LIVE`, `REPRODUCIBLE` | Uploads: mainnet [`eb90e5f9…`](https://stellar.expert/explorer/public/tx/eb90e5f911d097cbbaf724bed6ab670a7a2cf3843c4a1ffb89397ce34ce05135), testnet [`2d6baec6…`](https://stellar.expert/explorer/testnet/tx/2d6baec6ecf690266226141fe1a0bf747f58978be3537180416722180dfec96d). `pnpm verify` prints the code hash of the account it checks on either network. To rebuild: `pnpm build:contracts`, then `shasum -a 256 target/wasm32v1-none/release/paso_account.wasm`. The hash is reproduced with Rust 1.99.0 and Stellar CLI 28.1.0. `rust-toolchain.toml` names the `stable` channel, not a version, so another compiler can produce different bytes. |
| 4 | Anyone can deploy an account, and deploying twice changes nothing. | `VERIFIED LIVE` | Testnet: first [`e5fe8370…`](https://stellar.expert/explorer/testnet/tx/e5fe8370b67f0ba7d9e1f24f108824e3ecacad72663e73ffb03e79798a4050b4), second [`b1e88787…`](https://stellar.expert/explorer/testnet/tx/b1e8878740ee55801bcdaddd5b8985acb29024212f1ac8f0134ad2735ec455b3). Mainnet: the owner's account was deployed by the fee payer in [`8da9a459…`](https://stellar.expert/explorer/public/tx/8da9a45941d661070efbbf0c0276f7d483488ce2e5003e478dc1f0feef57b6ea). Hub tests `deploy_is_idempotent`, `deploy_needs_no_authorization`. |
| 5 | An account can only be created with the owner its address was derived from. | `REPRODUCIBLE` | `deploy` in `contracts/hub/src/lib.rs` uses the owner as salt and as constructor argument. Hub test `deployed_account_has_owner`. |
| 6 | The contracts have no administrator, no upgrade function and no way to change an owner. | `REPRODUCIBLE` | Read `contracts/account/src/lib.rs` (three functions) and `contracts/hub/src/lib.rs` (four functions). It also means the code on mainnet cannot be patched or paused. |

## The signature

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 7 | A Stellar contract call was authorised by an Ethereum signature. | `VERIFIED LIVE`, `REPRODUCIBLE` | Mainnet: [`85cb7efa…`](https://stellar.expert/explorer/public/tx/85cb7efa882a1cc6cc54c294bd7d60e5c7b6e47c8221ff7625fb44f6623e2322); `pnpm verify 85cb7efa882a1cc6cc54c294bd7d60e5c7b6e47c8221ff7625fb44f6623e2322 --network mainnet` exits 0. Testnet: [`43a92797…`](https://stellar.expert/explorer/testnet/tx/43a92797a315f742ef121ec607e9d2ca23b68e10eb6d2ce931f5e7f7f0ad6d90), SUCCESS, ledger 5159648; `pnpm verify 43a92797a315f742ef121ec607e9d2ca23b68e10eb6d2ce931f5e7f7f0ad6d90` exits 0. Both signatures were made by a script holding the key, not by a wallet extension. |
| 8 | The signed message is rebuilt on chain from the calls being authorised. A call changed after signing is refused. | `VERIFIED LIVE`, `REPRODUCIBLE` | Mainnet: [`eb945398…`](https://stellar.expert/explorer/public/tx/eb94539839cba10012c01cea9453410d740d89194c2e99c4b33958aec144b6a3), FAILED, `txFailed, invokeHostFunctionTrapped`, host log `["failed account authentication with error", CBWU43ND…XEZ7EPX, Error(Contract, #2)]`. Testnet: [`ded23530…`](https://stellar.expert/explorer/testnet/tx/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181), FAILED, ledger 5160302, same error; earlier ones [`32a1c98d…`](https://stellar.expert/explorer/testnet/tx/32a1c98dd9f14ffcae41448cdacd525f5f76b073aa695cc9a3c018bd56ade1b3), [`e8a91143…`](https://stellar.expert/explorer/testnet/tx/e8a91143725b27bdd36fd997b6262d3196048e0edf4793e9bbf5c388bc0e9d7a). Steps 1 and 6 print the error. `pnpm verify` on any of them exits 1. Account tests `rejects_changed_argument`, `rejects_changed_recipient`, `rejects_changed_contract_or_function`, `rejects_added_call`, `rejects_removed_call`, `rejects_reordered_calls`. Step 7 makes a new one. These transactions were built to fail and submitted on purpose; no relayer sends them. |
| 9 | The message that is signed lists exactly the calls that execute. | `REPRODUCIBLE` | The two rows above, and [ENCODING.md](ENCODING.md). This is a claim about the EIP-712 message. How a wallet lays it out on screen is not claimed; see Wallets below. |
| 10 | A signature is valid for one account, on one network, once, until its expiry. | `REPRODUCIBLE` | Account tests `rejects_other_account`, `rejects_other_network`, `rejects_other_payload`. Hub test `twin_signature_cannot_be_replayed_or_stretched`. Nonce and expiry are enforced by the Soroban host, not by Paso's code. |
| 11 | One signature covers a call and the calls nested in it. | `VERIFIED LIVE` | Exits: mainnet [`fccc2318…`](https://stellar.expert/explorer/public/tx/fccc2318b8322cc020fd0d6c0a84f05dea45a36725ae9ba24f36a6a7287d76c6), testnet [`6cae28f1…`](https://stellar.expert/explorer/testnet/tx/6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f). Each authorises `hub.exit` and the nested USDC `transfer`; `pnpm verify` prints both calls. Hub test `twin_exits_with_one_ethereum_signature`. |
| 12 | Calls are listed root first, then sub-calls depth first, and that is the order the host uses. | `REPRODUCIBLE` | Account test `host_lists_contexts_root_first_then_depth_first`, which goes through the host's own authorisation path. |
| 13 | The Rust contract and the TypeScript SDK agree on 11 signing vectors: text, digest and recovered signer. | `REPRODUCIBLE` | `pnpm test:contracts` and `pnpm test:sdk`. The vectors use stand-in payloads and test addresses. Building the payload from a real entry is covered by the SDK's testnet tests and by the live transactions. |
| 14 | Malleable and malformed signatures are refused. | `REPRODUCIBLE` | Account tests `rejects_high_s`, `rejects_out_of_range_r_and_s`, `rejects_v_2`, `rejects_flipped_recovery_id`, `rejects_signature_of_the_wrong_length`, `never_accepts_an_arbitrary_r`. An `r` that is not a curve point aborts in the host rather than returning a typed error. |

## Mainnet

One run on 2026-10-12 with real USDC, for the owner `0x20806157d9607050204bbbCd37CE71498B35D46c`, made by `scripts/e2e.ts`. Times are block and ledger close times, UTC.

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 15 | What mainnet covers: the hub, the account code, and this one scripted run. | `VERIFIED LIVE` | The rows of this section and the deployment rows above. The web app and the relayer were not part of it; see Not claimed. |
| 16 | 1 USDC was burned on Base for the owner's Stellar account. | `VERIFIED LIVE` | Approval [`0x53eb5943…`](https://basescan.org/tx/0x53eb5943435834ca70659f5bf3715e5c7d7f82c10516955083260a316920f469), burn [`0x460008a2…`](https://basescan.org/tx/0x460008a250884ff32698bd849f2094f2217c8b613a3ce3c5041a44730194994c) at 17:42:43, both sent by the owner's own address. The attestation time of 2 seconds was measured by the script. |
| 17 | Real USDC was delivered into an account that did not exist yet: 0.99987 USDC, with 0.00013 kept by Circle. | `VERIFIED LIVE` | Delivery [`a742bf77…`](https://stellar.expert/explorer/public/tx/a742bf77748cc1d2fb25347996dea79fa4e3827d7005cf6391588874a44fe1a0) at 17:44:32. The account was deployed 16 minutes later, in [`8da9a459…`](https://stellar.expert/explorer/public/tx/8da9a45941d661070efbbf0c0276f7d483488ce2e5003e478dc1f0feef57b6ea). The first delivery transaction was sent with the minimum fee and never reached a ledger; it was sent again with a higher bid, which is why the delivery is 109 seconds after the burn. The scripts now resend automatically. |
| 18 | The Ethereum key moved USDC out of the account on mainnet, to an address that had no account either. | `VERIFIED LIVE`, `REPRODUCIBLE` | Transfer [`85cb7efa…`](https://stellar.expert/explorer/public/tx/85cb7efa882a1cc6cc54c294bd7d60e5c7b6e47c8221ff7625fb44f6623e2322) at 18:00:52: 0.1 USDC to `CCSLYO2GFX5G7STNB37YZ44KB7WLBB72UH5Z7CD3UUZ64RAU6AHT4LNX`, the never-deployed account of `0xEe67130Fa530c04b88D6Fd99fcc7D1D1494841f8`. Step 6. |
| 19 | USDC went back to Base with one signature. | `VERIFIED LIVE` | Exit [`fccc2318…`](https://stellar.expert/explorer/public/tx/fccc2318b8322cc020fd0d6c0a84f05dea45a36725ae9ba24f36a6a7287d76c6) at 18:00:57: 0.5 USDC, fee cap 0, Fast Transfer. Mint on Base [`0x5b713522…`](https://basescan.org/tx/0x5b713522befbbeeb702d9bb8d48e4fc13da7585b3222ec52e5e7296caf3e4776) at 18:01:09, to the owner's address, submitted by the owner. The attestation time of 7 seconds was measured by the script. |
| 20 | An `approve` for amount `1`, signed by the owner, was accepted. A signature made for amount `1` and submitted with `10000000000000` was refused. | `VERIFIED LIVE` | Accepted [`9f7172de…`](https://stellar.expert/explorer/public/tx/9f7172de421fe48032130cf76432432a4a1a3298e0003ff3763e759d3b0ba8a2) at 18:01:12. Refused [`eb945398…`](https://stellar.expert/explorer/public/tx/eb94539839cba10012c01cea9453410d740d89194c2e99c4b33958aec144b6a3) at 18:01:17. |
| 21 | Stellar fees of the run: 0.0658391 XLM for the delivery and 0.1124682 XLM for the five transactions after it. The owner's account paid none. | `VERIFIED LIVE` | "Fee charged" on each transaction: delivery 0.0658391, account deployment 0.0262901, transfer 0.0398373, exit 0.0426572, `approve` 0.0022547, the refused one 0.0014289. All have the source account `GAS65I36DQSMBSEZRN5KXDJMRCNEWNEX2VANOQB2QZQX5JX2X6D4SQBM`. |
| 22 | Putting the contracts on mainnet cost 15.3768808 XLM, once. | `VERIFIED LIVE` | Account code [`eb90e5f9…`](https://stellar.expert/explorer/public/tx/eb90e5f911d097cbbaf724bed6ab670a7a2cf3843c4a1ffb89397ce34ce05135) 9.3681676, hub code [`c3eca151…`](https://stellar.expert/explorer/public/tx/c3eca151541a5e66d2d7679a37492686cd5dd46a1c5f7c66c1f9f8bcb6139161) 5.9556408, hub deployment [`9285fcdb…`](https://stellar.expert/explorer/public/tx/9285fcdb5d3f065c196816810ff6af1ff453ece88824e5775bd4602154082426) 0.0530724. |
| 23 | The run was continuous. | `NOT CLAIMED` | The delivery is at 17:44 and the remaining steps start at 18:00. It was continued as a second part. The 32-second figure below is from testnet. |

## Fees and the relayer

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 24 | The owner needs no XLM. A separate account paid the fee of every call. | `VERIFIED LIVE` | Every linked Stellar transaction has a source account that is neither the owner nor the account: `GAS65I36DQSMBSEZRN5KXDJMRCNEWNEX2VANOQB2QZQX5JX2X6D4SQBM` on mainnet, `GCWHW56HL2KP7ASCMWKP3GAO3HMUJ7XX6KH7S3PYALU6ZMZOCEP5VLRQ` on testnet. `pnpm verify` prints it as `Fee paid by`. |
| 25 | The account holds USDC with no trustline. | `VERIFIED LIVE` | Deliveries [`a742bf77…`](https://stellar.expert/explorer/public/tx/a742bf77748cc1d2fb25347996dea79fa4e3827d7005cf6391588874a44fe1a0) and [`f7c95418…`](https://stellar.expert/explorer/testnet/tx/f7c95418993326f42b05c8a682e9dc3a9a7e18d0ad267b168eba09b1a40d23f1) credit a contract address. A contract address has no trustlines; the USDC contract keeps its balance. Step 4 reads it. |
| 26 | The relayer route `POST /api/relay` deployed an account and relayed signed calls, paying the fees. Testnet only. | `VERIFIED LIVE` | From the end-to-end script: deploy [`0ec43de4…`](https://stellar.expert/explorer/testnet/tx/0ec43de437e650f7db5aa8bf942bf2f7460a168020f17ddfceae7c9f51febda9), call [`5a6cf2ec…`](https://stellar.expert/explorer/testnet/tx/5a6cf2ece6050bcd5d96d59b71162f1de514119ae8acbc99adbcbc37158bb890), SUCCESS, ledger 5160022. From the web app: a 0.1 USDC send [`ee5ca8c9…`](https://stellar.expert/explorer/testnet/tx/ee5ca8c9244c23c942ff2f2a8a280130bae2c58b66a67e272c40857909f70a0d); `pnpm verify` on it exits 0. Each relayed transaction has one operation and one authorisation entry. |
| 27 | The faucet route `POST /api/demo/fund` and the delivery route `POST /api/cctp/deliver` ran from the web app. Testnet only. | `VERIFIED LIVE` | Faucet burn on Base Sepolia [`0xb3474363…`](https://sepolia.basescan.org/tx/0xb3474363c81c3f1458423a1003f38c24deba51a17b5700cb71b386262b5854dd), delivered by the relayer in [`0e906ad1…`](https://stellar.expert/explorer/testnet/tx/0e906ad1652c2f5c2635d0082085d7b13bbfe309856944bf7a062239987d6669). |
| 28 | The route `POST /api/cctp/complete` finished an exit on Base. Testnet only. | `VERIFIED LIVE` | Exit from the app [`f568145f…`](https://stellar.expert/explorer/testnet/tx/f568145fef34bceac94cfd5286c8a461c3315462f548fb451606434d122a035a), minted on Base Sepolia by the server's account in [`0x126161a9…`](https://sepolia.basescan.org/tx/0x126161a91176872959d8141ee6d449c93f0f0ae33d82dfc3d62377acf7467f94). |
| 29 | The relayer refuses a call that was changed after signing, before sending anything. | `REPRODUCIBLE` | In the web app a changed send was answered with `bad_signature`, HTTP 422. Nothing was sent, so no transaction exists to link. The test is in `apps/web/test/relay.test.ts` and needs `RELAYER_SECRET` and `PASO_E2E_OWNER_KEY`. The refusals that are on chain were submitted directly. |
| 30 | For a relayed call the relayer attaches one authorisation entry, for the owner's account, on a contract invocation, under a fee cap. | `REPRODUCIBLE` | `apps/web/lib/server/relayer.ts` and `assertOnlyAccountEntries` in `packages/sdk/src/auth.ts`. `PASO_OFFLINE=1 pnpm test:web` runs the offline part, including the fee cap and the daily budget. The tests that try to borrow the relayer's authority on testnet are in `apps/web/test/relay.test.ts` and need keys. |
| 31 | A fee payer cannot change a signed call or move the owner's funds. | `REPRODUCIBLE` | The account refuses any change, as shown above. A fee payer holds no key of the account. |
| 32 | Anyone can submit instead of the relayer. | `VERIFIED LIVE`, `REPRODUCIBLE` | The mainnet run and the scripted testnet run used no relayer: `scripts/e2e.ts` submitted through the SDK from a funded account. Step 7 does the same with your own account. |
| 33 | Testnet fee samples: deploy 0.010577 XLM, `approve` 0.0020918, CCTP delivery 0.0756425, USDC transfer to an address with no balance 0.0633319, exit 0.0659997. | `VERIFIED LIVE` | "Fee charged" on [`0ec43de4…`](https://stellar.expert/explorer/testnet/tx/0ec43de437e650f7db5aa8bf942bf2f7460a168020f17ddfceae7c9f51febda9), [`5a6cf2ec…`](https://stellar.expert/explorer/testnet/tx/5a6cf2ece6050bcd5d96d59b71162f1de514119ae8acbc99adbcbc37158bb890), [`f7c95418…`](https://stellar.expert/explorer/testnet/tx/f7c95418993326f42b05c8a682e9dc3a9a7e18d0ad267b168eba09b1a40d23f1), [`dc3db1dd…`](https://stellar.expert/explorer/testnet/tx/dc3db1dd76496889c53a0007d3017e6b0d8019848c4ebbe555f9899b76eadf63), [`6cae28f1…`](https://stellar.expert/explorer/testnet/tx/6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f). One sample each. |

## Across chains on testnet

One scripted run on 2026-10-12, for the owner `0x7880DA9a52Af491f76421869d4e28DC0A4D1767C`. Times are block and ledger close times, UTC.

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 34 | 1 USDC was burned on Base Sepolia for the owner's Stellar account, through Circle's CctpForwarder route as a Fast Transfer. | `VERIFIED LIVE` | Approval [`0x488a7aa0…`](https://sepolia.basescan.org/tx/0x488a7aa038e69448b0cc83701b3dd4295904400a4622df64f5d18f48653cab4b), burn [`0x43c00d27…`](https://sepolia.basescan.org/tx/0x43c00d27bf35c2288c160e6e1bfad424a206dc0e0b2d0ae901e7b20a88879b9e) at 17:10:58. Both were sent by `0xEe67130Fa530c04b88D6Fd99fcc7D1D1494841f8`, a separate payer, not by the owner's address. |
| 35 | The USDC arrived in the account on Stellar: 0.99987 USDC, with 0.00013 kept by Circle. | `VERIFIED LIVE` | Delivery [`f7c95418…`](https://stellar.expert/explorer/testnet/tx/f7c95418993326f42b05c8a682e9dc3a9a7e18d0ad267b168eba09b1a40d23f1) at 17:11:07. It calls Circle's CctpForwarder and carries no authorisation entry. Step 5 queries Circle's record. The attestation time of 7 seconds was measured by the script. |
| 36 | An Ethereum address was paid on Stellar before it had an account. | `VERIFIED LIVE`, `REPRODUCIBLE` | Transfer [`dc3db1dd…`](https://stellar.expert/explorer/testnet/tx/dc3db1dd76496889c53a0007d3017e6b0d8019848c4ebbe555f9899b76eadf63) at 17:11:12: 0.1 USDC to `CAT44DMN6RQ44HZDEBJUSBWRJ3YOICUNPFHYIG6FSEUWFEBUYWIVY7FJ`, the account of `0xC801b29BC8eE267cA2C353fF146FFa642Cc2BE85`. Step 4 shows it undeployed and holding USDC. Hub test `receives_before_it_is_deployed`. |
| 37 | USDC went back to Base Sepolia with one signature. | `VERIFIED LIVE` | Exit [`6cae28f1…`](https://stellar.expert/explorer/testnet/tx/6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f) at 17:11:17. Mint [`0xd81b8b7e…`](https://sepolia.basescan.org/tx/0xd81b8b7e8f762910712494e3fba1b29144f2cef41a27081c44adb820ee5b137d) at 17:11:30, to the owner's address, submitted by the separate payer. The attestation time of 9 seconds was measured by the script. |
| 38 | From the burn on Base to the mint back on Base: 32 seconds. | `VERIFIED LIVE` | Block times of that burn and that mint. One run, on testnet. |
| 39 | The accepted and the refused `approve` of that run. | `VERIFIED LIVE` | Accepted [`b8a81489…`](https://stellar.expert/explorer/testnet/tx/b8a81489a2b20babc3ceadf6c9b22ba15965c725a6594b3413de6c4aadc91ac5), refused [`ded23530…`](https://stellar.expert/explorer/testnet/tx/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181), one ledger apart. |
| 40 | Incoming USDC uses Circle's contracts only. Paso adds no bridge contract for it. | `VERIFIED LIVE` | The deliveries on both networks call Circle's CctpForwarder, MessageTransmitter and TokenMessengerMinter. |
| 41 | The direct inbound route: mint straight to the account's contract id through `receive_message`. | `BUILT, NOT RUN LIVE` | `route: "direct"` in `packages/sdk/src/evm.ts`. Every live run used the forwarder route. |
| 42 | Standard finality transfers, and a non-zero fee cap on exit. | `BUILT, NOT RUN LIVE` | Options of `fundFromEvm` and of the `exit` action. Every live transfer was a Fast Transfer, and every live exit ran with a fee cap of 0. |
| 43 | `hub.exit` works against Circle's TokenMessengerMinter. | `VERIFIED LIVE` | The exits [`fccc2318…`](https://stellar.expert/explorer/public/tx/fccc2318b8322cc020fd0d6c0a84f05dea45a36725ae9ba24f36a6a7287d76c6), [`6cae28f1…`](https://stellar.expert/explorer/testnet/tx/6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f) and [`f568145f…`](https://stellar.expert/explorer/testnet/tx/f568145fef34bceac94cfd5286c8a461c3315462f548fb451606434d122a035a). The hub's unit tests use a stand-in for Circle's contract. |

## Tests

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 44 | 29 account tests and 15 hub tests pass. | `REPRODUCIBLE` | `pnpm test:contracts`. Step 3. |
| 45 | 200 SDK tests pass offline. | `REPRODUCIBLE` | `PASO_OFFLINE=1 pnpm test:sdk`. Without the flag 8 more read Stellar testnet. Two more need `PASO_E2E_OWNER_KEY`, and one of those moves USDC. |
| 46 | 321 web app and relayer tests pass offline. | `REPRODUCIBLE` | `PASO_OFFLINE=1 pnpm test:web`. 23 more send testnet transactions and need `RELAYER_SECRET` and `PASO_E2E_OWNER_KEY`. |

## Wallets

| # | Claim | Tag | Evidence |
|---|---|---|---|
| 47 | The web app signs in the browser with a demo key and the contract accepts it. | `VERIFIED LIVE` | The app's send [`ee5ca8c9…`](https://stellar.expert/explorer/testnet/tx/ee5ca8c9244c23c942ff2f2a8a280130bae2c58b66a67e272c40857909f70a0d) and exit [`f568145f…`](https://stellar.expert/explorer/testnet/tx/f568145fef34bceac94cfd5286c8a461c3315462f548fb451606434d122a035a) on testnet. The demo key is a key held by the page, not a wallet. |
| 48 | A wallet extension such as MetaMask signs this message through `eth_signTypedData_v4`. | `BUILT, NOT RUN LIVE` | `sign` in the SDK takes a viem account or wallet client. Every signature in the linked transactions was made by a script or by the app's demo key, through viem's EIP-712 signer. No wallet extension has been exercised live. |
| 49 | The web app resolves ENS names. | `BUILT, NOT RUN LIVE` | `apps/web/lib/client/ens.ts`. Not exercised live. |

## Not claimed

- **Audited.** There is no audit and no formal verification, on either network.
- **The web app or the relayer on mainnet.** Both are set up for testnet. Mainnet was exercised by one scripted run.
- **Other source chains.** Only Base and Base Sepolia have been used. Other CCTP chains are untested.
- **Key recovery or rotation.** A lost Ethereum key is a lost account.
- **Smart-contract wallets.** ERC-1271 signatures are not accepted. Neither are passkeys or multisig.
- **"First".** Paso does not claim to be the first at any part of this. See prior art below.
- **A readable message for every call.** Nested arguments appear as hashes. Amounts are raw integers and contracts are addresses. The signature's expiry is not displayed.
- **Tested wallets.** No wallet extension and no hardware wallet has been tested.
- **A verified build.** The check in `pnpm verify` compares the code hash on chain with a hash recorded in this repository. No third-party build attestation is published.
- **A decentralised or always-on relayer.** It is one server with in-memory limits. It can decline. The fallback is to submit from any funded account.
- **Long-lived accounts.** Every account here is hours old. The contracts never extend TTLs, and restoring an archived account has not been exercised.
- **Typical mainnet fees.** The mainnet figures are one sample each, from one run.
- **Load.** No load test has been run.
- **A published package.** `@paso/sdk` is not on npm.
- **Privacy.** Owner addresses, account addresses and calls are public.

## Statements about other projects

These come from those projects' public material and are not verified by anything in this repository.

- MetaMask's Stellar support creates a classic account that needs 1 XLM plus 0.5 XLM per trustline, in MetaMask only.
- EIP-712 verification inside a Soroban `__check_auth` exists in LayerZero's OneSig multisig for Stellar.
- OpenZeppelin's Stellar smart accounts ship ed25519 and WebAuthn verifiers.

Paso's part is narrower: an account derived from the Ethereum address itself, with the displayed message rebuilt on chain from the calls being authorised.
