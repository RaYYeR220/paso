# Security

Paso is unaudited and runs on testnet only. This document says what the contracts guarantee, what each party can and cannot do, and what is out of scope.

## What is protected

Whatever a Paso account can authorise: the USDC it holds, and any contract call made in its name. One rule protects it. A call from the account executes only if the owner's Ethereum key signed a message that lists exactly that call.

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
| A signature is used once, before its expiry | The host consumes the entry's nonce and refuses an expired entry. Both are inside `payload`, which is part of the digest. | `rejects_other_payload`, `twin_signature_cannot_be_replayed_or_stretched` |
| Signatures are not malleable | `s` must be in the lower half of the curve order, `r` in range, the recovery byte one of 0, 1, 27, 28. | `rejects_high_s`, `rejects_out_of_range_r_and_s`, `rejects_v_2`, `rejects_flipped_recovery_id` |
| Only contract calls are authorised | A contract creation in the tree returns `UnsupportedContext`. | `rejects_create_contract_context` |
| There is no other way in | No admin, no upgrade function, no way to change the owner. | The contract's source |

The on-chain demonstration is a transaction that changed one argument after signing and was submitted on purpose: [`ded23530…`](https://stellar.expert/explorer/testnet/tx/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181). It failed with `Error(Contract, #2)`.

The format is specified in [ENCODING.md](ENCODING.md).

## What the hub guarantees

Source: [`contracts/hub/src/lib.rs`](../contracts/hub/src/lib.rs).

- **An address belongs to one owner.** The deployment salt is the owner's address, and `deploy` passes that same address to the account's constructor. Nobody can create the account at an owner's address with a different owner. Tests: `address_is_deterministic`, `address_matches_the_off_chain_derivation`, `deployed_account_has_owner`.
- **Deploying is open and harmless.** Anyone may call `deploy`. Calling it again changes nothing. Tests: `deploy_is_idempotent`, `deploy_needs_no_authorization`.
- **The account code is fixed.** The hub stores the account wasm hash at construction and has no function to change it.
- **`exit` needs the account's authorisation.** It moves exactly the signed amount, to the signed recipient and domain. It rejects non-positive amounts and amounts with a seventh decimal. The hub holds nothing between calls. Tests: `exit_requires_auth`, `exit_pulls_and_burns`, `exit_rejects_non_positive_amount`, `exit_rejects_dust`, `twin_refuses_an_exit_that_differs_from_what_was_shown`.
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
7. The resource fee is at most `RELAYER_MAX_RESOURCE_FEE`, 0.5 XLM by default, and the day's total stays under `RELAYER_MAX_DAILY_FEES`, 50 XLM by default.

The transaction it sends has one operation and one entry. The live example is [`5a6cf2ec…`](https://stellar.expert/explorer/testnet/tx/5a6cf2ece6050bcd5d96d59b71162f1de514119ae8acbc99adbcbc37158bb890).

The same guard is in the SDK as `assertOnlyAccountEntries`. `prepare`, `sign`, `relayRequest`, `simulateSigned` and `submitWith` all apply it, so a fee payer that uses the SDK without the relayer gets the same protection.

Relayer tests for this rule, in [`apps/web/test/relay.test.ts`](../apps/web/test/relay.test.ts): a transfer of the relayer's XLM with a source-account entry is refused, alone and next to a genuine entry; a second entry for another address is refused; an entry for an account that is not the owner's is refused; a code upload is refused; a call that does not use the signed entry is refused; a call above the fee cap is refused. These tests send testnet transactions and need keys.

### Its other transactions

The relayer builds two kinds of transaction itself. Callers supply no entry for them.

- **Deploying an account.** The call is `hub.deploy(owner)`. If the simulation asks for any authorisation, the transaction is not sent.
- **Delivering a CCTP message.** The caller supplies a burn transaction hash. The relayer fetches the message and the attestation from Circle and builds the call from those bytes. Circle's MessageTransmitter asks its caller to authorise the call when it is called directly; that one authorisation, for exactly the call being made with nothing nested under it, is the only authorisation the relayer account ever gives. Anything more is refused.

The fee cap and the daily budget apply to these too.

### Limits on use

Requests are limited per caller and per route, per minute. Faucet payouts are also limited per caller per hour, per owner per day and in total per day. The counts are kept in memory: they reset when the server restarts, and each server instance counts on its own. The limiter fails closed. A caller is identified only by headers the hosting platform sets; elsewhere all callers share one bucket.

`PASO_NETWORK=mainnet` is refused unless `PASO_ALLOW_MAINNET=true` is set.

## A malicious dapp or front end

A dapp chooses what the wallet is asked to sign. It cannot make the contract accept something the wallet did not show.

### What it can do

- **Ask for a harmful call and show it truthfully.** An `approve` or a `transfer` to the attacker is displayed as exactly that. The owner has to read it.
- **Rely on raw values.** Amounts are integers in the token's smallest unit and contracts are `C…` addresses. The message has no decimals, symbols or names. `50000000` and `5000000` are easy to confuse, and a look-alike token contract is a different address that the owner has to recognise.
- **Hide meaning in a hashed argument.** A vector, map or struct argument appears as `xdr:<sha256>`. The owner cannot read it.
- **Use the lack of types.** The number `5` and the string `5` display the same.
- **Choose the expiry.** The signature's last valid ledger is inside `payload` and is not displayed. A dapp can ask for a far expiry, keep the signature and submit it later. It still works once only.
- **Withhold or delay.** It can fail to submit a signed call.

### What it cannot do

- Change the contract, the function, any argument, or the order or number of calls after signing.
- Reuse a signature, or move it to another account or network.
- Have the wallet show one set of calls while the signature authorises another. The contract rebuilds the text from the calls that run; if the text differs from what was signed, the recovered address is not the owner.
- Create the owner's account with a different owner.

## The key

Whoever holds the Ethereum private key controls the account. A compromised wallet, a leaked seed phrase or a signature given to a malicious request is outside what the contracts can prevent. There is no recovery and no rotation: a lost key is a lost account.

## Circle and CCTP

USDC moves between Base and Stellar through Circle's contracts and Circle's attestation service. Paso adds no bridge of its own for incoming USDC. Delivery on Stellar is permissionless: Circle's contracts check the attestation and decide where the USDC goes. The hub's `exit` calls Circle's `deposit_for_burn` with no destination caller, so anyone can complete the mint on the other chain, and the recipient is fixed by the signed call. A failure or a pause at Circle stops cross-chain movement; it does not give anyone access to an account.

## Known limits and non-goals

- Unaudited.
- Testnet only. Nothing is deployed on mainnet.
- No key rotation, no recovery, no guardians, no spending limits, no session keys.
- No upgrade path. A bug in the account code cannot be patched in place.
- Externally owned accounts only. ERC-1271 smart-contract wallets cannot sign.
- Browser wallets are untested. The signatures in the linked transactions were made by scripts through viem's EIP-712 signer.
- Nested arguments are bound by hash and are not readable.
- The message shows raw integers and addresses, carries no types, and does not show the signature's expiry.
- A signature whose `r` is not a valid curve point aborts in the host instead of returning a typed error. The transaction still fails.
- The contracts have no TTL extension logic. Archived entries are restored automatically by the network when used.
- The relayer's limits are in memory and per instance. They bound abuse; they are not an account of who used what.
- Hiding who pays whom is not a goal. Owner addresses, account addresses and calls are public.

## Reporting an issue

Open an issue at <https://github.com/RaYYeR220/paso/issues>. The project runs on testnet and holds no real funds, so reports are handled in the open.
