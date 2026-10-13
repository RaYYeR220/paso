# Security

Paso is unaudited: no external party has reviewed the code. The contracts are deployed on Stellar mainnet and on testnet. The hosted app and its relayer serve both networks; on mainnet the app works with the user's own wallet only, with no demo key and no faucet. This document says what the contracts guarantee, what each party can and cannot do, and what is out of scope.

The project reviewed its own contracts adversarially and published everything it found, with tests that reproduce it, in [AUDIT.md](AUDIT.md). That review is not a third-party audit and not formal verification. Ids such as F-01 below refer to its findings. The deployed contracts cannot be changed, so none of those findings can be patched.

## What is protected

Whatever a Paso account can authorise: the USDC it holds, and any contract call made in its name. One rule protects it. A call from the account executes only if the owner's Ethereum key signed a message that lists exactly that call.

## Who can spend from an account

Every Ethereum address has a Stellar account address, and anyone can pay it. Only an address controlled by a plain private key can ever spend from it (F-01).

The account obeys one thing: a 65-byte secp256k1 signature that recovers to its owner address. An address with no private key behind it gets an account that can receive and never send. That covers a Safe, a smart-contract wallet, an ERC-4337 account, an exchange deposit contract, a token contract and any other contract. USDC sent to such an account is lost for good. There is no recovery path and no administrator.

The contracts cannot tell the two kinds of address apart: `deploy` and `address_of` take any twenty bytes. The check has to happen before the payment.

- Ask the EVM chains you serve for the code at the address. Code means a contract, with one exception: an EIP-7702 delegation, 23 bytes that start `0xef0100`, still has its key.
- No code is not proof of a key. A smart-contract wallet that has not been deployed yet has no code on any chain and cannot be detected in advance.
- The proof that works is a signature: the holder signs typed data, and the 65 bytes recover to the address.

What this project's code does about it:

- **The SDK** exports `ownerKind(address)`. It asks Ethereum, Base and Base Sepolia for the code at the address and answers `contract`, `wallet` (no code found) or `unknown` (a chain did not answer). An EIP-7702 delegation counts as a key. `prepare` does not call it; code that uses the SDK has to.
- **The app** runs that check before a transfer to the account of an Ethereum address. For a contract it blocks the send. The send goes ahead only if the sender ticks "Send anyway. I understand this USDC can never be moved again." An address that could not be checked, or that has never used its Stellar account, needs a tick on "I know this address is a regular wallet." A connected wallet that is a contract is refused. Before a wallet can bring USDC over, it signs one message that moves nothing, and the signature has to recover to its address.

None of this detects a smart-contract wallet that is not deployed yet, and none of it applies to code that does not go through the app or that skips `ownerKind`. Do not send to the account of an address unless you know its holder can sign EIP-712 typed data with a plain key. Test: `f01_account_of_a_keyless_address_accepts_funds_it_can_never_spend`.

## Parties

| Party | Holds | Trusted for |
|---|---|---|
| Owner | The Ethereum private key | Reading what the wallet displays before signing |
| Wallet | The key, on the owner's behalf | Showing the typed data it signs |
| Dapp or front end | Nothing | Nothing. It builds the request; the contract checks it |
| Relayer, or any fee payer | A Stellar key with XLM | Nothing but liveness. It pays fees |
| Soroban host | | Passing the real calls and payload to `__check_auth`, consuming nonces, enforcing expiry |
| Circle | CCTP contracts and the attestation service | Burning, attesting and minting USDC across chains |

## What the account contract guarantees

The contract has three functions: `__constructor(owner)`, `owner()` and `__check_auth`. Source: [`contracts/account/src`](../contracts/account/src).

| Guarantee | How | Tests |
|---|---|---|
| Only the owner's key authorises | The 20-byte owner is stored at construction. `__check_auth` recovers the secp256k1 signer of the digest, derives its Ethereum address and compares. | `rejects_wrong_signer`, `rejects_signature_of_another_owner` |
| The signature covers exactly the calls that run | The digest is not taken from the transaction. The contract renders every call the host is about to authorise to text and hashes that text as EIP-712. A changed argument gives a different digest and a different recovered address. | `rejects_changed_argument`, `rejects_changed_recipient`, `rejects_changed_contract_or_function`, `rejects_added_call`, `rejects_removed_call`, `rejects_reordered_calls` |
| A signature is for one account | The `account` field is the address of the contract doing the check. | `rejects_other_account` |
| A signature is for one network | The domain salt is the ledger's network id. | `rejects_other_network` |
| A signature is used once, and not after its expiry | The host consumes the entry's nonce and refuses an expired entry. Both are inside `payload`, which is part of the digest. The expiry is chosen by whoever builds the request, is not displayed and has no upper bound, and a transaction that fails does not use the signature up: see [Lifetime of a signature](#lifetime-of-a-signature). | `rejects_other_payload`, `twin_signature_cannot_be_replayed_or_stretched`, `f02_signature_is_live_through_its_expiry_ledger_and_dead_in_the_next` |
| The mirrored form of a signature is refused | `s` must be in the lower half of the curve order, `r` in range, the recovery byte one of 0, 1, 27, 28. The signature bytes are still not unique: the recovery byte has two accepted spellings, 0 or 27 and 1 or 28, so two byte strings encode the same signature. That is harmless, because the host consumes the nonce, but the bytes of a signature are not an identifier (F-11). | `rejects_high_s`, `rejects_out_of_range_r_and_s`, `rejects_v_2`, `rejects_flipped_recovery_id`, `f11_one_signature_has_two_accepted_65_byte_spellings` |
| Only contract calls are authorised | A contract creation in the tree returns `UnsupportedContext`. | `rejects_create_contract_context` |
| There is no other way in | No admin, no upgrade function, no way to change the owner. | The contract's source |

The on-chain demonstration is a transaction that changed one argument after signing and was submitted on purpose. On mainnet: [`eb945398…`](https://stellar.expert/explorer/public/tx/eb94539839cba10012c01cea9453410d740d89194c2e99c4b33958aec144b6a3). On testnet: [`ded23530…`](https://stellar.expert/explorer/testnet/tx/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181). Both failed with `Error(Contract, #2)`.

The format is specified in [ENCODING.md](ENCODING.md).

## What the hub guarantees

Source: [`contracts/hub/src/lib.rs`](../contracts/hub/src/lib.rs).

- **An address belongs to one owner.** The deployment salt is the owner's address, and `deploy` passes that same address to the account's constructor. Nobody can create the account at an owner's address with a different owner. Tests: `address_is_deterministic`, `address_matches_the_off_chain_derivation`, `deployed_account_has_owner`.
- **Deploying is open and harmless.** Anyone may call `deploy`. Calling it again changes nothing. Tests: `deploy_is_idempotent`, `deploy_needs_no_authorization`.
- **The account code is fixed.** The hub stores the account wasm hash at construction and has no function to change it.
- **`exit` needs the account's authorisation.** It moves exactly the signed amount, to the signed recipient and domain. It rejects non-positive amounts and amounts with a seventh decimal. It checks nothing else: the fee cap, the recipient, the domain and the finality threshold go to Circle's contract as given (F-10). Tests: `exit_requires_auth`, `exit_pulls_and_burns`, `exit_rejects_non_positive_amount`, `exit_rejects_dust`, `twin_refuses_an_exit_that_differs_from_what_was_shown`, `f10_hub_forwards_fee_cap_recipient_domain_and_finality_unchecked`.
- **The hub holds nothing between calls, as long as Circle's contract takes the full amount.** Nothing enforces that. The hub has no function that moves its own balance, so USDC sent to the hub's address, or left there by Circle's contract, stays there for good (F-09). The hub's address is not a deposit address. Tests: `exit_pulls_and_burns`, `f09_hub_keeps_for_good_what_the_messenger_leaves_and_what_is_sent_to_it`, `f09_hub_cannot_exit_its_own_balance`.
- **Every exit reaches Circle as the hub.** One block on the hub at Circle stops `exit` for every account (F-06). See [Circle and CCTP](#circle-and-cctp).
- **No administrator.** The hub has no privileged function.

## The relayer

The relayer is a server with a funded Stellar key. Source: [`apps/web/lib/server/relayer.ts`](../apps/web/lib/server/relayer.ts).

### What it can do

- Decline a request, or be offline.
- See the requests it is sent: the owner's address and the call. All of it becomes public on chain anyway.
- Be made to spend XLM on fees, within its caps.

### What it cannot do

- Change a signed call, its arguments or its order. The signature covers them and the account contract would refuse.
- Move an owner's funds, or authorise anything as the account.
- Use a signature twice, or on another account or network.
- Stop the owner. Any funded Stellar account can submit the same signed call with `submitWith` from the SDK.

### The rule for relayed calls

For a call it relays, the relayer attaches **one authorisation entry, for the owner's account, on a contract invocation, under a fee cap**. Nothing else passes.

Why: on Stellar, whoever pays the fee signs the transaction envelope, and that signature also satisfies every authorisation entry that uses source-account credentials. A fee payer that forwarded entries as given could be handed an entry that authorises a transfer of its own XLM, and its envelope signature would approve it.

What the relayer checks before it signs:

1. The host function is a contract invocation. Uploading code or creating a contract is refused.
2. The request carries exactly one entry. It has plain address credentials, never source-account credentials and never delegated ones. Its address is the account derived from the `owner` in the request; the relayer derives it again and does not trust the address named in the entry.
3. The entry is signed and not expired.
4. A simulation that enforces the entry succeeds. The account contract verifies the signature for this exact call, as it will on chain.
5. A second simulation with no entry attached records what the call asks for. It must be that same single invocation by that same account. A call that also wants the relayer's own authorisation, or that does not use the signed entry, stops here.
6. The final simulation, made when the transaction is built, reports no authorisation other than the entry.
7. The signature expires within 120 ledgers, about ten minutes, of the latest ledger. A signature made to last longer is not passed on.
8. The resource fee is at most `RELAYER_MAX_RESOURCE_FEE`, and the day's total stays under `RELAYER_MAX_DAILY_FEES`: by default 0.5 XLM and 50 XLM on testnet, 0.3 XLM and 2 XLM on mainnet. On mainnet nothing is sent that would take the relayer's balance below 2 XLM.

The transaction it sends has one operation and one entry. The live example is [`5a6cf2ec…`](https://stellar.expert/explorer/testnet/tx/5a6cf2ece6050bcd5d96d59b71162f1de514119ae8acbc99adbcbc37158bb890).

The same guard is in the SDK as `assertOnlyAccountEntries`. `prepare`, `sign`, `relayRequest`, `simulateSigned` and `submitWith` all apply it, so a fee payer that uses the SDK without the relayer gets the same protection.

Relayer tests for this rule, in [`apps/web/test/relay.test.ts`](../apps/web/test/relay.test.ts): a transfer of the relayer's XLM with a source-account entry is refused, alone and next to a genuine entry; a second entry for another address is refused; an entry for an account that is not the owner's is refused; a code upload is refused; a call that does not use the signed entry is refused; a call above the fee cap is refused. These tests send testnet transactions and need keys.

### Its other transactions

The relayer builds three kinds of transaction itself. Callers supply no entry for them.

- **Deploying an account.** The call is `hub.deploy(owner)`. If the simulation asks for any authorisation, the transaction is not sent. On testnet anyone can ask for it through `POST /api/deploy`. On mainnet only a relayed first call triggers it, once its signature has been checked.
- **Delivering a CCTP message.** The caller supplies a burn transaction hash. The relayer fetches the message and the attestation from Circle and builds the call from those bytes. Circle's MessageTransmitter asks its caller to authorise the call when it is called directly; that one authorisation, for exactly the call being made with nothing nested under it, is the only authorisation the relayer account ever gives. Anything more is refused.

- **Finishing an exit on Base.** The caller supplies the hash of an exit on Stellar. Once Circle has attested it, the server's account on Base submits Circle's `receiveMessage` and pays the gas. Circle's contract decides who receives the USDC: the recipient named in the signed exit. The server completes only exits made through the hub from Stellar to Base, simulates the mint first and sends nothing that does not simulate. Mints are limited per caller and per day, stop below an ETH floor and above a gas price cap, and are off on mainnet unless `PAY_BASE_MINTS_ON_MAINNET=true`. Where the server does not pay, which is mainnet by default and on the hosted app, it checks the exit in the same way and returns the attested message; the owner's wallet submits the mint and pays its gas. Anyone else can submit the same mint from any wallet.

The fee cap and the daily budget apply to the two Stellar kinds.

### Limits on use

Requests are limited per caller and per route, per minute. Faucet payouts are also limited per caller per hour, per owner per day and in total per day. The counts are kept in memory: they reset when the server restarts, and each server instance counts on its own. The limiter fails closed. A caller is identified only by headers the hosting platform sets; elsewhere all callers share one bucket.

The server serves mainnet only when `PASO_ALLOW_MAINNET=true` and `RELAYER_SECRET_MAINNET` are both set. Mainnet reads only its own variables, those ending in `_MAINNET`, and its relayer must be a different Stellar account from the testnet relayer. Each network has its own queue, limits and daily budget. [ENVIRONMENT.md](ENVIRONMENT.md) lists them.

On mainnet `POST /api/deploy` answers 404. The relayer deploys an account there only together with that account's first signed call, after it has checked off chain that the signature is the owner's: a bare request to deploy proves nothing about who asks, and would spend the relayer's XLM.

## A malicious dapp or front end

A dapp chooses what the wallet is asked to sign. It cannot make the contract accept something the wallet did not show.

### What it can do

- **Ask for a harmful call and show it truthfully.** An `approve` or a `transfer` to the attacker is displayed as exactly that. The owner has to read it.
- **Rely on raw values.** Amounts are integers in the token's smallest unit and contracts are `C…` addresses. The message has no decimals, symbols or names. `50000000` and `5000000` are easy to confuse, and a look-alike token contract is a different address that the owner has to recognise.
- **Hide meaning in a hashed argument.** A vector, map or struct argument appears as `xdr:<sha256>`. So do 256-bit integers, timepoints, durations and muxed addresses. The last of these reaches a plain token transfer: `transfer` accepts a muxed `M…` destination, and the prompt then shows the recipient as a hash (F-04). The owner cannot read any of them.
- **Use the lack of types and of structure.** The number `5` and the string `5` display the same. A `String` argument is shown byte for byte, line breaks and direction overrides included. The call list does not show which call is nested in which (F-07).
- **Choose the expiry.** The signature's last valid ledger is inside `payload` and is not displayed. It has no upper bound. A dapp can ask for a far expiry, keep the signature and submit it later. It still works once only. See [Lifetime of a signature](#lifetime-of-a-signature).
- **Ask for a mainnet signature under a testnet story.** The prompt does not name the network. See [The network in the prompt](#the-network-in-the-prompt).
- **Withhold, delay or resubmit.** It can fail to submit a signed call. It can also submit again a signed call whose transaction failed, until the signature expires.

### What it cannot do

- Change the contract, the function, any argument, or the order or number of calls after signing.
- Reuse a signature, or move it to another account or network.
- Have the wallet show one set of calls while the signature authorises another. The contract rebuilds the text from the calls that run; if the text differs from what was signed, the recovered address is not the owner.
- Create the owner's account with a different owner.

## The network in the prompt

The wallet prompt carries the network only as an opaque salt (F-03). The domain is `{name: "Paso", version: "1", salt}`, with no `chainId` and no `verifyingContract`. A mainnet request and a testnet request for the same owner differ in the salt, in the `account` address and in the contract addresses. No field says "mainnet", and a wallet may show the salt as hex or not at all.

| Network | `salt` |
|---|---|
| Mainnet | `0x7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979` |
| Testnet | `0xcee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472` |

The binding is sound: a signature for one network does not verify on the other (`rejects_other_network`). The display is the weak point. The same Ethereum key controls an owner's account on both networks, so a site that looks like a testnet demo can ask for a mainnet authorisation, and the prompt has the same shape.

- Do not sign Paso prompts on a site you do not trust with a key whose mainnet account holds funds. Try a demo with a key that holds nothing on mainnet.
- Know your mainnet account address. It is the `account` of every mainnet prompt.
- The app names the network in words where the user reviews the call ("for Stellar mainnet"), shows the salt next to its meaning, and refuses a prepared call whose salt is not the selected network's before it reaches the review. The SDK builds the typed data itself for the network it is given. Switching the app to mainnet asks once per browser for a confirmation that real funds are involved.
- None of this changes the wallet prompt. A copy of the app, or a front end that does not use the SDK, can leave it all out.

No wallet extension has been tested, so how a wallet shows the salt is not known.

## Lifetime of a signature

A signature is a bearer instrument until its expiry ledger. Three facts follow from how the Soroban host handles nonces and expiry (F-02).

- **The expiry is not shown and has no upper bound.** It is inside `payload`. The host refuses an expiry more than `max_entry_ttl − 1` ledgers ahead of the ledger in which the entry is used; on mainnet `max_entry_ttl` is 3,110,400 ledgers, about 180 days. That limits how wide the usable window is, not how far away it lies. A signature with an expiry two years out is refused today and works in the 180 days before that date. Whoever builds the request chooses the expiry. The SDK sets 24 ledgers, about two minutes, and refuses more than 120, about ten minutes. The hosted relayer refuses a signature that expires more than 120 ledgers ahead. A front end that does not use the SDK, and a fee payer other than the hosted relayer, are bound by neither.
- **A failed transaction leaves the signature live.** The nonce is consumed inside the transaction. If the transaction fails after the signature check, for lack of balance for example, the nonce is rolled back with everything else, and the signed entry is public. Until its expiry anyone can submit it again. Signing a second request after a failure leaves two live signatures for the same payment.
- **There is no revocation.** The only way to cancel is to use the same nonce in another signed entry, and that blocks the original only while the host keeps the nonce record: until the replacement's own expiry, and never less than 17,280 ledgers, about a day, on mainnet. A short-lived replacement cancels a long-lived signature for a while and no longer. The account has no key rotation.

What to do:

- Treat every signature as live until its expiry ledger, even if its transaction failed.
- After a failure, submit the same signed call again. Do not sign a new one while the old one is live. The app does this: when the relayer's answer is lost, it sends the same signed call again.
- Keep validity short. The app shows how many seconds the signature will be good for at review, and after a call that did not go through it says until when the signature stays usable.
- If you signed on a site you no longer trust, move the funds out of the account.

Tests: `f02_far_expiry_signature_is_refused_today_and_accepted_later`, `f02_signature_is_live_through_its_expiry_ledger_and_dead_in_the_next`, `f02_failed_transaction_leaves_the_signature_usable_by_anyone`, `f02_cancelling_by_spending_the_nonce_wears_off`.

## The key

Whoever holds the Ethereum private key controls the account. A compromised wallet, a leaked seed phrase or a signature given to a malicious request is outside what the contracts can prevent. There is no recovery and no rotation: a lost key is a lost account.

## Circle and CCTP

USDC moves between Base and Stellar through Circle's contracts and Circle's attestation service. Paso adds no bridge of its own for incoming USDC. Delivery on Stellar is permissionless: Circle's contracts check the attestation and decide where the USDC goes. The hub's `exit` calls Circle's `deposit_for_burn` with no destination caller, so anyone can complete the mint on the other chain, and the recipient is fixed by the signed call. A failure or a pause at Circle stops cross-chain movement; it does not give anyone access to an account.

The hub is the single CCTP caller for every exit (F-06). `exit` calls `deposit_for_burn` with the hub as `caller`, and Circle's contract applies its denylist to that caller, not to the account that is leaving. The hub is the sender of every burn message. `exit` is open to any address, so an address Circle has denylisted can still leave through the hub, which gives Circle a reason to block the hub.

If Circle denylisted the hub, or the token's admin deauthorised the hub's USDC balance (the issuer account has `auth_revocable` set):

- It would stop `hub.exit` for every account at once. The hub cannot be redeployed at the same address, and account addresses are tied to this hub.
- It would not touch the USDC in any account. Owners keep control of their accounts. Transfers on Stellar keep working, and so do deliveries from Base, which do not pass through the hub.
- It would not close the way out. An account can call Circle's contract itself: `approve`, then `deposit_for_burn` with the account as caller. That takes two signatures where `exit` takes one, and it is closed only to an account Circle has blocked itself.

On mainnet on 2026-10-12 the hub was not denylisted, its USDC balance was authorised, and Circle's contract was not paused. Test: `f06_one_denylist_entry_for_the_hub_stops_exit_for_every_account`, against a stand-in that applies the check where Circle's contract does.

## Lifetime of the contracts

Neither contract extends the lifetime of anything, and using an account does not extend it either (F-05). Every entry lives for the network's minimum, 2,073,600 ledgers from its creation, about 120 days at five seconds a ledger. After its last ledger an entry is archived: it is not deleted, and it cannot be used until someone restores it.

| Entry | Live until ledger | About |
|---|---|---|
| Account code, shared by every account | 66,981,816 | 9 February 2027 |
| Hub code | 66,981,817 | 9 February 2027 |
| Hub instance | 66,981,825 | 9 February 2027 |
| An account's instance | 2,073,599 ledgers after the ledger of its deployment | 120 days after its deployment |
| An account's USDC balance entry | The same when created. The token contract tops it up to 30 days when it is used with less than 29 days left | |

These are the values on mainnet at ledger 64,908,935, on 2026-10-12. Anyone may have extended them since. [AUDIT.md](AUDIT.md#f-05-nothing-keeps-the-contracts-alive) has the commands that read the current values.

| Archived entry | What stops until it is restored |
|---|---|
| Account code | Every account's `__check_auth`: no Paso account anywhere can authorise anything |
| Hub code or hub instance | `deploy`, `exit`, `address_of`. Deriving an address off chain still works |
| One account's instance | That account |
| One account's USDC balance entry | Transfers to and from that account |

Nothing is lost when an entry is archived. No path was found by which archival loses funds.

**Who can extend or restore.** Anyone with a funded Stellar account. No key of the project or of an owner is needed.

**What it costs.** Simulated on mainnet on 2026-10-12, for an extension to the longest lifetime the network allows, about 60 more days:

| Entry | Resource fee |
|---|---|
| Account code | 5.39 XLM |
| Hub code | 3.43 XLM |
| Hub instance | 0.031 XLM |
| One account instance | 0.016 XLM |

That is about 54 XLM a year for the two code entries. Restoring an entry after it has been archived costs about what creating it did; the two uploads were 9.37 XLM and 5.96 XLM. The restore figure is an estimate, and a restore has not been exercised.

**Who pays.** Owners hold no XLM by design, and the hosted relayer does not cover this. It refuses a call whose simulation says entries have to be restored, and its cap on resource fees per transaction, 0.3 XLM on mainnet and 0.5 XLM on testnet by default, is far below the cost of restoring either code entry. After an expiry, the next person to act needs a funded Stellar account, their own or someone else's.

**The commands.** `PAYER` is a Stellar CLI identity, or the secret key, of an account with XLM on mainnet; it signs and pays. `3110399` is the network's `max_entry_ttl` minus one, the longest lifetime an extension can ask for.

```sh
RPC=https://mainnet.sorobanrpc.com
NET="Public Global Stellar Network ; September 2015"
PAYER=alice

# The account code, shared by every account
stellar contract extend \
  --wasm-hash 2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee \
  --ledgers-to-extend 3110399 \
  --source-account $PAYER --rpc-url $RPC --network-passphrase "$NET"

# The hub code
stellar contract extend \
  --wasm-hash aeaa1c72f607071fd1f383638fa0c850df1c15bd051b3e1061ac57bc0e46b045 \
  --ledgers-to-extend 3110399 \
  --source-account $PAYER --rpc-url $RPC --network-passphrase "$NET"

# The hub instance
stellar contract extend \
  --id CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK \
  --ledgers-to-extend 3110399 \
  --source-account $PAYER --rpc-url $RPC --network-passphrase "$NET"

# One account instance: --id is the account's C… address
stellar contract extend \
  --id CBWU43NDIBPC6SD2WKVNJH6A5ROHGMSDJWAVLCO3RITO5Q264XEZ7EPX \
  --ledgers-to-extend 3110399 \
  --source-account $PAYER --rpc-url $RPC --network-passphrase "$NET"
```

Add `--build-only` to print a transaction without signing or sending it. An archived entry is restored with `stellar contract restore`, which takes the same `--wasm-hash` or `--id`.

Tests: `f05_account_code_never_extends_the_lifetime_of_anything`, `f05_hub_code_never_extends_the_lifetime_of_anything`, `f05_using_an_account_extends_no_lifetime`.

## Known limits and non-goals

- Unaudited. The project's own review is in [AUDIT.md](AUDIT.md). It is not a third-party audit and not formal verification.
- Mainnet has seen two journeys: one from the scripts and one through the hosted app, driven by a scripted wallet. On mainnet the app brings over at most 25 USDC at a time and its relayer spends at most 2 XLM of fees a day.
- No key rotation, no recovery, no guardians, no spending limits, no session keys.
- No upgrade path. A bug in the account code cannot be patched in place.
- Externally owned accounts only. ERC-1271 smart-contract wallets cannot sign, and USDC sent to the account of a contract address is lost. See [Who can spend from an account](#who-can-spend-from-an-account).
- Wallet extensions are untested. The signatures in the linked transactions were made by scripts, by the web app's demo key, or by a scripted wallet that speaks the standard wallet interface (EIP-1193), all through viem's EIP-712 signer.
- Nested arguments are bound by hash and are not readable. Neither are 256-bit integers, timepoints, durations and muxed addresses.
- The message shows raw integers and addresses, carries no types, and does not show the signature's expiry or the name of the network.
- A signature stays usable until its expiry even if its transaction failed, and it cannot be revoked. See [Lifetime of a signature](#lifetime-of-a-signature).
- A signature whose `r` is not a valid curve point aborts in the host instead of returning a typed error. The transaction still fails.
- The contracts have no TTL extension logic. The shared account code and the hub are archived after ledger 66,981,816, about 9 February 2027, unless someone extends them. Extending and restoring are open to anyone and cost XLM. See [Lifetime of the contracts](#lifetime-of-the-contracts).
- Every exit depends on Circle accepting the hub as caller. See [Circle and CCTP](#circle-and-cctp).
- The relayer's limits are in memory and per instance. They bound abuse; they are not an account of who used what.
- Hiding who pays whom is not a goal. Owner addresses, account addresses and calls are public.

### Smaller limits

From the project's own review. Each has a test named after its id in `contracts/account/src/audit.rs` or `contracts/hub/src/audit.rs`; [AUDIT.md](AUDIT.md) has the detail.

- **F-04. A muxed recipient is shown as a hash.** A `transfer` to an `M…` address displays its destination as `xdr:<sha256>`. Do not sign a `transfer` whose recipient starts with `xdr:` unless you produced that address yourself. The SDK's `prepare` and the app refuse a muxed recipient for a transfer; for a generic call the app marks a muxed argument as unreadable and asks for a confirmation.
- **F-07. The displayed text is typeless, flat and unsanitised.** Values of different types can show the same text, the call list does not show nesting, and a `String` argument reaches the wallet with line breaks and direction overrides intact. None of this lets a signature authorise a call with different text; `payload` binds the exact values. It limits what reading the prompt can tell you. Refuse prompts with `xdr:` values you cannot account for. For a generic call the app shows each argument's type, marks text that can mislead and values bound by hash, and waits for the owner to confirm the marked lines; it warns and does not refuse.
- **F-08. A `Bytes` argument above about 25 kB cannot be authorised.** The signature check then needs more memory than a transaction is allowed. Such a call is impossible for a Paso account. No funds are at risk.
- **F-09. The hub cannot give anything back.** Never send anything to the hub's address.
- **F-10. The hub validates amounts only.** A recipient that cannot be minted to on the chosen domain is burned on Stellar and lost. Use `exit` for EVM destinations only, and take the delivered amount from Circle, not from the hub's `Exit` event.
- **F-11. Signature bytes are not unique, and the credential encoding is not signed.** Anyone can re-wrap a signed entry in the delegated credential encoding and it still verifies; the same call runs, once. Do not use the bytes of a signature or of a signed entry as an identifier.
- **F-12. As a delegated signer, `account` names the signer.** If a Paso account is registered as a signer of another account, the prompt says `account: <the Paso account>` while the other account's authority is used. `account` means "the contract that checks the signature".
- **F-13. A leading byte-order mark is part of a `String`.** The contract hashes `String` bytes as they are. A signer that drops the mark while decoding gets `BadSignature`. In JavaScript, decode with `ignoreBOM: true`, as the SDK's renderer does.

## Reporting an issue

Open an issue at <https://github.com/RaYYeR220/paso/issues>. There is no private channel and no bounty. The contracts on mainnet are unaudited and cannot be paused or upgraded; do not keep in an account more than you can afford to lose.

## Limits of the hosted relayer

Rate limits, daily budgets and the record of transactions in flight are kept in memory by each server instance, so on a host that runs several instances each one enforces its own, and a restart starts them over. The worst case is therefore bounded per instance and per day. On testnet: the test USDC the faucet's payer holds above its reserve, the daily fee budget in test XLM, and the test ETH spent on gas for the daily number of mints on Base. On mainnet, where there is no faucet and the server pays for no mints: 2 XLM of fees a day per instance, and never more than the relayer account holds above 2 XLM. The relayer never holds user funds: it cannot move or redirect them, and a call it relays can only do what its owner signed. Everything the relayer does (deploying an account, relaying a signed call, delivering a transfer to Stellar, completing one on Base) can be done by anyone with their own funded account, using the SDK or the scripts: `pnpm deliver` delivers a transfer from Base with any funded Stellar account, and `pnpm mint` completes one on Base with any Base account that has gas.
