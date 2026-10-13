# Security review of the Paso contracts

This is a review of Paso's two contracts by the project itself. Its method was adversarial: each guarantee the project states was treated as a claim to break, and every attempt is recorded here, the ones that failed included. It is not a third-party audit and it is not formal verification. No external party has reviewed this code. Paso's status stays **unaudited**.

The contracts are deployed on Stellar mainnet and cannot be changed. Nothing found here can be patched in the deployed code, so each finding says what to do about it today. Every finding that a test can show has a test in this repository.

| | |
|---|---|
| Date | 2026-10-12 |
| Kind | A review of the project's own code, by the project. Adversarial in method. Not a third-party audit. Not formal verification. |
| In scope | [`contracts/account/src/lib.rs`](../contracts/account/src/lib.rs), [`eip712.rs`](../contracts/account/src/eip712.rs), [`render.rs`](../contracts/account/src/render.rs) and [`contracts/hub/src/lib.rs`](../contracts/hub/src/lib.rs) |
| Out of scope | The SDK, the relayer and the web app: read as context, not reviewed. Circle's contracts: read from Circle's published source, not reviewed. Wallets: none was used. |
| Deployed code | Account wasm `2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee`. Hub wasm `aeaa1c72f607071fd1f383638fa0c850df1c15bd051b3e1061ac57bc0e46b045`. Hub [`CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK`](https://stellar.expert/explorer/public/contract/CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK) on Stellar mainnet. |
| Built with | Rust 1.99.0, Stellar CLI 28.1.0, `soroban-sdk` 29.0.0 |
| Network state used | Stellar mainnet, protocol 29, ledger 64,908,935 |

Source files as reviewed, sha256:

| File | sha256 |
|---|---|
| `contracts/account/src/lib.rs` | `d949867a583ce12a87a3047068324bcd9297c6b4c8cc55790c61cdd2b577140c` |
| `contracts/account/src/eip712.rs` | `f9192e12def6bb558b4cdb431fe37c51c2f267d2891c4430b6565c0f4e82bce0` |
| `contracts/account/src/render.rs` | `edaafec496212bfb856f2977e8eb2dd0e69fb4ef9271e80a1ae06013fa59f6a4` |
| `contracts/hub/src/lib.rs` | `f0d077318b05a560d18d4cec3f4f7915c9cb5e977f28f435eb93b505eaa6d777` |

Each `lib.rs` has two more lines today, `#[cfg(test)]` and `mod audit;`. They declare the tests of this review and are compiled only for `cargo test`. Without them each file has the hash above:

```sh
grep -v -x 'mod audit;' contracts/account/src/lib.rs | uniq | shasum -a 256
grep -v -x 'mod audit;' contracts/hub/src/lib.rs | uniq | shasum -a 256
```

The compiled code is what runs, and it is unchanged. Build it and compare with the chain:

```sh
stellar contract build
shasum -a 256 target/wasm32v1-none/release/paso_account.wasm target/wasm32v1-none/release/paso_hub.wasm
# 2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee  target/wasm32v1-none/release/paso_account.wasm
# aeaa1c72f607071fd1f383638fa0c850df1c15bd051b3e1061ac57bc0e46b045  target/wasm32v1-none/release/paso_hub.wasm

RPC=https://mainnet.sorobanrpc.com
NET="Public Global Stellar Network ; September 2015"

# The account code stored on mainnet, hashed locally
stellar contract fetch --wasm-hash 2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee \
  --rpc-url $RPC --network-passphrase "$NET" | shasum -a 256

# The hash of the code the hub runs
stellar contract info hash --id CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK \
  --rpc-url $RPC --network-passphrase "$NET"
```

The hashes are reproduced with Rust 1.99.0 and Stellar CLI 28.1.0. Another compiler version can produce different bytes.

## Method

- The four source files were read in full, together with the parts of the Soroban host (`soroban-env-host` 29.0.0) they depend on: authorisation, nonces, expiry, key recovery and entry lifetimes.
- Every suspected weakness got a test. Where the weakness held, it is a finding. Where the contract refused, it is listed under [Hypotheses tested and rejected](#hypotheses-tested-and-rejected).
- Deployed state was read from Stellar mainnet: code hashes, the hub's stored configuration, entry lifetimes, and the settings of Circle's contracts.
- Fees were measured by simulating transactions against mainnet. Nothing was sent.
- Both contracts were rebuilt and their hashes compared with the code on chain.

Seven questions were asked: whether a signature can be forged or reshaped; what exactly a signature is bound to; whether two different calls can show the same text; whether anyone can stop an owner from acting; whether the hub can be used to move someone else's USDC; whether the code on chain is the code in this repository; and anything else that turned up.

## Result

No way was found to make an account authorise a call its owner did not sign, to use a signature twice, to move it to another account, network or call, or to move anyone's USDC through the hub without that account's signature. The code on chain matches the source and the published configuration.

That is what one review by the project found. It is not a statement that nothing else is there.

What was found is of three kinds:

- a design property that loses funds for good when the product is used the way it invites (F-01);
- weaknesses in what the signer can see or control (F-02, F-03, F-04, F-07);
- limits on liveness and dependencies (F-05, F-06, F-08), and smaller points (F-09 to F-13).

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 6 |
| Informational | 6 |

Severity weighs how bad the outcome is against how likely it is.

## Findings

| Id | Finding | Severity | Evidence |
|---|---|---|---|
| [F-01](#f-01-the-account-of-an-ethereum-address-that-has-no-private-key-receives-and-never-sends) | The account of an Ethereum address that has no private key receives and never sends | Medium | Test |
| [F-02](#f-02-a-signatures-lifetime-is-hidden-and-unbounded-a-failed-transaction-does-not-use-it-up-and-cancelling-it-does-not-last) | A signature's lifetime is hidden and unbounded, a failed transaction does not use it up, and cancelling it does not last | Low | Tests |
| [F-03](#f-03-the-signing-prompt-does-not-name-the-network) | The signing prompt does not name the network: a "testnet" request can be a mainnet authorisation | Low | Argued from the message format. No wallet was tested. |
| [F-04](#f-04-the-recipient-of-a-transfer-can-be-displayed-as-a-hash) | The recipient of a transfer can be displayed as a hash (muxed addresses) | Low | Test |
| [F-05](#f-05-nothing-keeps-the-contracts-alive) | Nothing keeps the contracts alive: code and instances are archived after about 120 days unless someone pays | Low | Read from mainnet. Fees simulated. Tests for the contract side. Restoring was not exercised. |
| [F-06](#f-06-the-hub-is-the-single-cctp-caller-for-every-exit) | The hub is the single CCTP caller for every exit: one denylist entry or one freeze stops them all | Low | Test against a stand-in that applies Circle's check |
| [F-07](#f-07-the-displayed-text-is-typeless-flat-and-unsanitised) | The displayed text is typeless, flat and unsanitised | Low | Tests for the contract side. How a wallet draws the text is argued. |
| [F-08](#f-08-a-call-with-a-bytes-argument-above-about-25-kb-can-never-be-authorised) | A call with a `Bytes` argument above about 25 kB can never be authorised | Informational | Tests |
| [F-09](#f-09-the-hub-cannot-give-anything-back) | The hub cannot give anything back: leftovers and mistaken transfers are permanent | Informational | Tests |
| [F-10](#f-10-the-hub-checks-sign-and-dust-only) | The hub checks sign and dust only; fee cap, recipient, domain and finality pass through unchecked | Informational | Test |
| [F-11](#f-11-the-signature-does-not-bind-the-credential-wrapper-or-the-spelling-of-the-recovery-byte) | The signature does not bind the credential wrapper or the spelling of the recovery byte | Informational | Tests |
| [F-12](#f-12-used-as-a-delegated-signer-the-account-field-names-the-signer) | Used as a delegated signer, the message's `account` names the signer, not the account being spent from | Informational | Test |
| [F-13](#f-13-a-string-that-starts-with-a-byte-order-mark-must-be-hashed-with-the-mark) | A `String` that starts with a byte-order mark must be hashed with the mark | Informational | Test |

## Running the tests

The tests of this review are in [`contracts/account/src/audit.rs`](../contracts/account/src/audit.rs) and [`contracts/hub/src/audit.rs`](../contracts/hub/src/audit.rs). They are deterministic and need no network. They load the compiled contracts, so build before testing.

```sh
pnpm test:contracts                  # stellar contract build && cargo test: 50 account tests, 28 hub tests

cargo test -p paso-account audit::   # the 21 account tests of this review
cargo test -p paso-hub audit::       # the 13 hub tests of this review
cargo test -p paso-account f08_ -- --nocapture   # prints the cost table of F-08
```

Every one of these tests passes, and a pass does not mean "safe". Read the name:

- A test named `f…` demonstrates a limit. What it asserts is the weakness itself. `f01_account_of_a_keyless_address_accepts_funds_it_can_never_spend` passes because the funds are stuck.
- A test named `n…` demonstrates an attack that was tried and is refused.

The older suites, [`contracts/account/src/test.rs`](../contracts/account/src/test.rs) and [`contracts/hub/src/test.rs`](../contracts/hub/src/test.rs), are referred to below by test name.

Commands that read mainnet use these two variables:

```sh
RPC=https://mainnet.sorobanrpc.com
NET="Public Global Stellar Network ; September 2015"
```

## The findings in detail

### F-01. The account of an Ethereum address that has no private key receives and never sends

**Severity: Medium.** Impact: high, a permanent loss of everything sent. Likelihood: low while few people pay other people's addresses; higher wherever a product offers "pay any address".

**What it is.** `hub.address_of` and `hub.deploy` accept any 20 bytes. The account's only way in is a secp256k1 signature whose keccak address equals the stored owner (`__check_auth` in `contracts/account/src/lib.rs`). There is no second path: no recovery, no administrator, and the code cannot be replaced (N-08).

An Ethereum address is not always a key. A Safe, a smart-contract wallet, any ERC-4337 account, an exchange deposit contract, a token contract and many ENS names resolve to addresses that no ECDSA key can sign for. The account derived from such an address deploys like any other, holds USDC like any other, and can never authorise anything.

A sender cannot tell a key from a contract by looking at an address. Asking a chain whether the address has code helps and does not settle it: a smart-contract wallet that has not been deployed yet has no code, on any chain, and looks exactly like an unused key address. An EIP-7702 delegation (code that starts with `0xef0100`) is the opposite case: the address has code and still has its key.

**Who is affected.** Whoever sends USDC to the Stellar account of such an address. The loss is per payment and falls on the sender. The intended recipient cannot rescue it.

**Reproduce.** `f01_account_of_a_keyless_address_accepts_funds_it_can_never_spend` in `contracts/hub/src/audit.rs`:

```sh
cargo test -p paso-hub f01_
```

The test deploys the account of `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, the address of the USDC token contract on Base, pays it, and shows that an exit with no authorisation and an exit signed by an arbitrary key are both refused. It shows the open door. It cannot show the shut one for every key; that part rests on the address not being derived from a key.

**What to do today.**

- Do not send to the Stellar account of an Ethereum address unless you know it is a plain key-controlled wallet whose holder can sign EIP-712 typed data.
- An integrator has to check the recipient before showing a deposit address: ask the chains it serves for the code at the address, refuse or warn loudly when there is code, treat an EIP-7702 delegation as a key, and say in the warning that an empty answer is not proof of a key. The SDK exports `ownerKind` for this ([`packages/sdk/src/owner.ts`](../packages/sdk/src/owner.ts)); it asks Ethereum, Base and Base Sepolia and has the same limit.
- For a wallet that is connected, ask for one harmless EIP-712 signature and check that it is 65 bytes and recovers to the address, before the account is offered as a place to receive funds. That proves the address can sign for its account.

### F-02. A signature's lifetime is hidden and unbounded, a failed transaction does not use it up, and cancelling it does not last

**Severity: Low.** Likelihood: low. Impact: medium. A call the owner did sign runs later than, or in addition to, what the owner expected. Never a call the owner did not sign.

**What it is.** Three facts.

1. *The expiry is hidden and has no upper bound.* The expiry ledger and the nonce are inside `payload`, which the signer sees as 32 bytes of hex. The Soroban host compares the expiry with the ledger at the moment the entry is used: it must not be past, and it must not be more than `max_entry_ttl − 1` ledgers ahead. On mainnet `max_entry_ttl` is 3,110,400 ledgers, about 180 days. That bounds the width of the window in which a signature works, not how far away the window can be. A signature with an expiry two years out is refused today and becomes usable about 180 days before that date. The contract adds no limit of its own.

2. *A failed transaction leaves the signature live.* The nonce is consumed inside the transaction. If the transaction fails for any reason after the signature check (not enough balance, a paused contract, a resource limit), the nonce is rolled back with everything else. The envelope, with the signed entry in it, is on the ledger for anyone to read. Until the expiry ledger, anyone can submit that entry again. A user who signs a fresh request after a failure has two live signatures for the same payment, and both can land.

3. *Cancelling does not last.* There is no revoke function. The only lever is to consume the same nonce with another signed entry. The host keeps the nonce record as a temporary ledger entry whose lifetime is the later of the *replacement's* expiry and the minimum temporary lifetime (17,280 ledgers, about a day, on mainnet). It is not tied to the expiry of the signature being cancelled. Cancelling holds only if the replacement's expiry is at least the original's. The owner also cannot read the nonce or the expiry in the wallet prompt; against a site that will not hand over the entry there is nothing to cancel with.

**Who is affected.** An owner who signed for a site that keeps the signature, and an owner who retries after a failed attempt. The account has no key rotation, so a signature that is out cannot be withdrawn.

**Reproduce.**

```sh
cargo test -p paso-account f02_
cargo test -p paso-hub f02_
```

- `f02_far_expiry_signature_is_refused_today_and_accepted_later`: signs with an expiry of twice `max_entry_ttl`, is refused, advances the ledger, is accepted.
- `f02_signature_is_live_through_its_expiry_ledger_and_dead_in_the_next`: the boundary.
- `f02_failed_transaction_leaves_the_signature_usable_by_anyone`: an exit fails on an empty account, the account is funded later, and the old entry goes through.
- `f02_cancelling_by_spending_the_nonce_wears_off`: a short-lived replacement blocks a long-lived signature, the nonce record expires, and the long-lived signature works again.

**What to do today.**

- Treat every Paso signature as live until its expiry ledger, even if its transaction failed.
- If you signed something on a site you no longer trust, move the funds out of the account. There is no other revocation.
- An integrator has to keep validity short and refuse long ones, show the expiry next to the wallet prompt, and after a failure resubmit the entry already signed instead of asking for a new signature while the old one is live. If a new one is needed before the old one expires, give it the old nonce so that only one of the two can land.
- A fee payer that accepts signed entries from others should refuse an expiry further ahead than it is willing to carry.
- To cancel, sign a no-effect call with the same nonce and an expiry at least as late as the original's.

### F-03. The signing prompt does not name the network

**Severity: Low.** Likelihood: low; it needs a hostile or compromised front end and a victim whose mainnet account holds funds. Impact: high for that victim.

**What it is.** The EIP-712 domain is `{name: "Paso", version: "1", salt}`. The salt is sha256 of the network passphrase. The binding is sound: a testnet signature does not verify on mainnet (`rejects_other_network`), and the network id is inside `payload` as well.

What the signer can see is another matter. A mainnet request and a testnet request for the same owner differ in three places: 32 bytes of hex in the domain, which a wallet may show as hex or not at all; the `account` address; and the contract addresses. None of them says "mainnet". There is no `chainId` for the wallet to compare with the connected chain, and no `verifyingContract` for the wallet, or for a transaction-screening service, to recognise.

| Network | `salt` |
|---|---|
| Mainnet | `0x7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979` |
| Testnet | `0xcee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472` |

The same Ethereum key controls an owner's testnet account and mainnet account. A site that offers a testnet demo, or a copy of one, can present a mainnet `transfer` of the owner's whole balance. The prompt has the same shape as a testnet prompt.

The same absence has two quieter consequences. Any site can ask for a signature under the name "Paso"; nothing in the request ties it to an origin or to a contract a wallet could allow-list. And a hardware wallet that clear-signs EIP-712 by contract address has nothing to key on.

**Who is affected.** An owner whose mainnet account holds funds and who signs on a front end they have no reason to trust.

**Reproduce.** There is nothing to run: this is a property of the message format, which [ENCODING.md](ENCODING.md) section 2 specifies. No wallet extension and no hardware wallet was used, so what a given wallet shows for the salt is not known.

**What to do today.**

- Do not sign Paso prompts on a site you do not trust with a key whose mainnet account holds funds. Try a testnet demo with a key that holds nothing on mainnet.
- The `account` in a mainnet prompt is your mainnet address, and the salt of a mainnet prompt starts `0x7ac33997`. Learn both.
- An integrator has to say the network in words next to the prompt, build the typed data itself for the network the user chose, and refuse to forward for signing any request whose salt is not that network's. Typed data handed in from outside is never signed as given.

### F-04. The recipient of a transfer can be displayed as a hash

**Severity: Low.** Likelihood: low. Impact: high per incident.

**What it is.** `render::text` gives an address a strkey only when it is an account or a contract. Every other kind of address is shown as `xdr:` and a sha256. [ENCODING.md](ENCODING.md) section 5 says so.

A muxed address is such a kind, and it can appear where a reader does not expect a hidden value. The token interface is `transfer(from: Address, to: MuxedAddress, amount: i128)`, and the Stellar Asset Contract behind USDC implements it. A transfer to `M…` credits the underlying `G…` account. The account authorises it with this text:

```
transfer [ "C…the account", "xdr:e79d3196f965c90f33a2d4d5c9e06046b28130763de8f94c8af8511c7926e5db", "50000000" ]
```

The signer sees a transfer of their USDC to a destination they cannot read. Legitimate use would train the habit: exchange deposit addresses are commonly muxed.

**Who is affected.** An owner asked to sign a transfer whose recipient is a muxed address. The web app refuses `M…` recipients in its recipient field ([`apps/web/lib/client/parse.ts`](../apps/web/lib/client/parse.ts)); a front end that passes them through shows the prompt above.

**Reproduce.** `f04_transfer_to_a_muxed_address_shows_the_recipient_as_a_hash`:

```sh
cargo test -p paso-account f04_ -- --nocapture
```

**What to do today.**

- Do not sign a `transfer` whose second argument starts with `xdr:` unless you produced that address yourself.
- An integrator has to refuse a call that contains an address other than an account or a contract, or decode it and show the `M…` form and its base `G…` next to the prompt.

### F-05. Nothing keeps the contracts alive

**Severity: Low.** Likelihood: high; it happens by default. Impact: low; no loss, a liveness dependency and a cost.

**What it is.** Neither compiled contract imports a host function that extends the lifetime of a ledger entry. On mainnet at ledger 64,908,935:

| Entry | Live until ledger | Ledgers left |
|---|---|---|
| Account code, shared by every account | 66,981,816 | 2,072,881 |
| Hub code | 66,981,817 | 2,072,882 |
| Hub instance | 66,981,825 | 2,072,890 |
| Instance of the example account [`CBWU43ND…XEZ7EPX`](https://stellar.expert/explorer/public/contract/CBWU43NDIBPC6SD2WKVNJH6A5ROHGMSDJWAVLCO3RITO5Q264XEZ7EPX) | 66,982,052 | 2,073,117 |

That is the network's minimum lifetime for a persistent entry, 2,073,600 ledgers. Ledgers closed five seconds apart on 2026-10-12; at that rate it is 120 days, and the code entries reach their last ledger about 9 February 2027. Every account instance gets the same lifetime from the day it is deployed, and using the account does not extend it: the example account was deployed in ledger 64,908,453, was used after that, and still has exactly the lifetime it was created with. A USDC balance entry gets the same lifetime when created; the token contract tops it up to 30 days when it is touched with less than 29 days left.

When an entry is archived:

| Archived entry | What stops until it is restored |
|---|---|
| Account code | Every account's `__check_auth`: no Paso account anywhere can authorise anything |
| Hub code or hub instance | `deploy`, `exit`, `address_of`. Deriving an address off chain still works |
| One account's instance | That account |
| One account's USDC balance entry | Transfers to and from that account |

Restoring is permissionless: the transaction that touches an archived entry declares the restore, and its fee payer pays for it. Extending is permissionless too. Simulated on mainnet, an extension to the longest lifetime the network allows, about 1,037,500 more ledgers or 60 days, costs:

| Entry | Resource fee |
|---|---|
| Account code | 5.39 XLM |
| Hub code | 3.43 XLM |
| Hub instance | 0.031 XLM |
| One account instance | 0.016 XLM |

At that rate keeping the two code entries alive costs about 54 XLM a year. Restoring after archival costs about what creating did; the uploads were 9.3681676 XLM and 5.9556408 XLM. That restore figure is an estimate from the network's rent formula, not a measurement.

Owners hold no XLM by design. The hosted relayer refuses a call whose simulation says entries have to be restored, and it refuses any transaction above its cap on resource fees, which is at most 0.5 XLM by default. After expiry the next user to act needs some other funded account to pay.

No path was found by which archival loses funds (N-10).

**Who is affected.** Every owner, as a liveness matter. Nobody loses funds. Someone has to pay, and nobody is obliged to.

**Reproduce.**

```sh
cargo test -p paso-account f05_
cargo test -p paso-hub f05_
```

- `f05_account_code_never_extends_the_lifetime_of_anything` and `f05_hub_code_never_extends_the_lifetime_of_anything` read the import section of each compiled contract.
- `f05_using_an_account_extends_no_lifetime` runs a successful exit and shows the account's instance, the account code and the hub's instance exactly where they were.

The lifetimes on mainnet:

```sh
stellar ledger entry fetch contract-code \
  --wasm-hash 2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee \
  --rpc-url $RPC --network-passphrase "$NET" --output json-formatted | grep liveUntilLedgerSeq

stellar ledger entry fetch contract-data \
  --contract CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK --instance \
  --rpc-url $RPC --network-passphrase "$NET" --output json-formatted | grep liveUntilLedgerSeq

stellar ledger latest --rpc-url $RPC --network-passphrase "$NET"
```

The fee of an extension, simulated and not sent. `--source-account` only has to name an account that exists:

```sh
stellar contract extend \
  --wasm-hash 2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee \
  --ledgers-to-extend 3110399 \
  --source-account GAS65I36DQSMBSEZRN5KXDJMRCNEWNEX2VANOQB2QZQX5JX2X6D4SQBM \
  --rpc-url $RPC --network-passphrase "$NET" --build-only \
  | stellar tx simulate \
      --source-account GAS65I36DQSMBSEZRN5KXDJMRCNEWNEX2VANOQB2QZQX5JX2X6D4SQBM \
      --rpc-url $RPC --network-passphrase "$NET" \
  | stellar xdr decode --type TransactionEnvelope --output json-formatted | grep resource_fee
```

The fee is in stroops, ten million to the XLM. It grows a little every ledger, because the same command extends from a later ledger.

**What to do today.**

- Anyone with a funded Stellar account can extend any of these entries. The commands are in [SECURITY.md](SECURITY.md#lifetime-of-the-contracts).
- If an account has been idle for months, check the lifetimes before relying on it, and have XLM on hand in some Stellar account.
- A fee payer that wants to serve accounts after an expiry has to accept transactions that restore entries, under a cap high enough to cover them.

### F-06. The hub is the single CCTP caller for every exit

**Severity: Low.** Likelihood: low. Impact: medium; the one-signature exit stops for everyone, nothing is lost, and a two-step way out remains.

**What it is.** `exit` calls Circle's `deposit_for_burn` with the hub as `caller`. Circle's contract requires the caller's authorisation and applies its denylist to that caller. The denylist is therefore applied to the hub, never to the account that is leaving. So is everything else that identifies the depositor: the sender of the burn message is the hub, and so is the depositor in Circle's event. `exit` is open to any address, not only Paso accounts.

Consequences:

- An address Circle has denylisted can still leave through the hub. That gives Circle a concrete reason to denylist the hub.
- One denylist entry for the hub ends `exit` for every user. So does a deauthorisation of the hub's USDC balance by the token's admin: the issuer account has `auth_revocable` set.
- The hub cannot be redeployed with a different caller at the same address, and accounts are tied to this hub.

On mainnet at the time of the review: `is_denylisted(hub)` is false, `authorized(hub)` is true, and Circle's contract is not paused.

A block on the hub does not touch what is in the accounts. An account can still leave without the hub: `approve` to Circle's contract, then `deposit_for_burn` with itself as caller. That takes two signatures where `exit` takes one.

**Who is affected.** Every owner who wants to leave Stellar with one signature. Nobody loses funds.

**Reproduce.** `f06_one_denylist_entry_for_the_hub_stops_exit_for_every_account`:

```sh
cargo test -p paso-hub f06_
```

The test uses a stand-in for Circle's contract that checks a denylist on `caller`. That Circle's contract does the same is read from its published source and from the interface it publishes on chain, not tested against its code. The state on mainnet:

```sh
stellar contract invoke --id CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL \
  --source-account GAS65I36DQSMBSEZRN5KXDJMRCNEWNEX2VANOQB2QZQX5JX2X6D4SQBM \
  --rpc-url $RPC --network-passphrase "$NET" --send=no \
  -- is_denylisted --account CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK

stellar contract invoke --id CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75 \
  --source-account GAS65I36DQSMBSEZRN5KXDJMRCNEWNEX2VANOQB2QZQX5JX2X6D4SQBM \
  --rpc-url $RPC --network-passphrase "$NET" --send=no \
  -- authorized --id CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK
```

`--send=no` simulates and sends nothing.

**What to do today.**

- Users lose nothing if the hub is blocked. Funds stay in the accounts and under the owners' keys.
- An integrator should be able to exit without the hub: the account's own `approve` and `deposit_for_burn`, as two signed calls.

### F-07. The displayed text is typeless, flat and unsanitised

**Severity: Low.** Likelihood: low to medium. Impact: medium, bounded by what the visible transfers and approvals say.

**What it is.** Each of the following is one string in the wallet, produced by values of different types:

| Text | Values that render to it |
|---|---|
| `5` | `u32`, `i32`, `u64`, `i64`, `u128`, `i128`, the `String` `5`, the `Symbol` `5` |
| `true` | `bool`, the `String` `true`, the `Symbol` `true` |
| `void` | void, the `String` `void`, the `Symbol` `void` |
| `0xdeadbeef` | `Bytes`, `BytesN<4>`, the `String` `0xdeadbeef` |
| `G…` or `C…` | an address, a `String` holding the same strkey |
| `xdr:<64 hex>` | a vector, map, struct, 256-bit integer, timepoint, duration, error, muxed address, and a `String` holding that same text |

Beyond types:

- The call list is flat. `a → [b, c]` and `a → [b → [c]]` give the same `calls`.
- A `String` is hashed byte for byte. Line breaks, bidirectional overrides and zero-width characters reach the wallet as they are, and the account accepts a signature over them.
- Function names are chosen by whoever wrote the contract being called.
- Amounts are raw integers in the token's smallest unit.

**What an attacker gains.** Not a different call. The digest is rebuilt from the calls that run, and `payload` binds the exact values, their types and the tree. A message that shows one text cannot authorise a call that would render to another. The collisions are between types, not within one: on 6,000 generated values no two different values of one type had the same text.

Type collisions are worth little in practice. A typed contract function rejects an argument of the wrong type, so a collision helps only against a contract that takes untyped values, or against the attacker's own contract, where the attacker controls the text anyway.

The realistic gain is confined to what the signer cannot read:

1. *A transfer to a hash.* F-04.
2. *A real protocol, a hidden route.* A router call such as `swap(amount_in, amount_out_min, path, to, deadline)` shows `path` as `xdr:…`. A hostile front end sets a path through a worthless token. The nested `transfer` of the user's USDC to a pool address is shown truthfully, and a legitimate swap looks exactly the same. For any call whose meaning sits in a vector or struct, the signer trusts the front end, whatever the prompt shows.
3. *A long list.* Hundreds of calls are affordable (F-08). A harmful one can sit in the middle.
4. *Injected structure.* A `String` argument with line breaks and text shaped like more fields. Whether this misleads depends on the wallet. It was not tested.

This is the ordinary risk of signing structured data from a site you do not trust, with fewer cues than an EVM signature usually carries. It does not break the guarantee the project states. It does limit what "the owner has to read it" can deliver.

**Who is affected.** An owner who signs on a hostile front end, for calls whose meaning is in values the prompt cannot show.

**Reproduce.**

```sh
cargo test -p paso-account f07_
```

- `f07_values_of_different_types_are_displayed_as_the_same_text`
- `f07_calls_with_differently_typed_arguments_give_one_displayed_message`
- `f07_call_list_does_not_show_which_call_is_nested_in_which`
- `f07_string_arguments_reach_the_wallet_with_control_characters_intact`
- `f07_values_without_a_text_form_are_displayed_as_hashes`
- `f07_within_one_type_no_two_of_6000_generated_values_share_a_text`: the edge of the finding. The contract's renderer agrees with a second renderer written from the table in ENCODING.md, on 6,000 generated values. A sample, not a proof.

How a given wallet draws these strings was not observed.

**What to do today.**

- Read every call in the list. Refuse prompts that contain `xdr:` values you cannot account for.
- An integrator has to refuse a `String` argument that contains control or formatting characters, show decimals and token symbols next to the prompt for tokens it knows, and warn on any `xdr:` argument and on more than a handful of calls.

### F-08. A call with a `Bytes` argument above about 25 kB can never be authorised

**Severity: Informational.** Likelihood: very low; no USDC or CCTP call carries that much. Impact: low; such calls are impossible for a Paso account, and no funds are at risk.

**What it is.** `render::hex` builds its output sixteen bytes at a time. Each append makes a new host object the size of everything written so far, so the memory charged grows with the square of the length. Mainnet allows 41,943,040 bytes of memory and 400,000,000 instructions per transaction. Measured on the compiled contract:

| `__check_auth` for | Instructions | Memory | Share of the memory limit |
|---|---|---|---|
| The shape of `hub.exit`, 2 calls | 3.4 M | 1.25 MB | 3 % |
| 100 transfer-shaped calls | 22.7 M | 2.3 MB | 5 % |
| 400 transfer-shaped calls | 84.2 M | 7.3 MB | 17 % |
| One `Bytes` of 8,000 bytes | 10.4 M | 5.4 MB | 13 % |
| One `Bytes` of 16,000 bytes | 19.9 M | 17.6 MB | 42 % |
| One `Bytes` of 24,000 bytes | 31.4 M | 37.8 MB | 90 % |
| One `Bytes` of 26,000 bytes | 34.6 M | 44.1 MB | 105 % |
| One `Bytes` of 64,000 bytes | 118.8 M | 258.7 MB | 617 % |
| Two `Bytes` of 18,000 bytes each | 42.3 M | 42.6 MB | 101 % |
| One `String` of 100,000 bytes | 7.7 M | 1.7 MB | 4 % |

The squares add up over all `Bytes` arguments of one authorisation. Strings, symbols and hashed values are linear and cheap. The number of calls is not a practical limit: the transaction size limit is reached before it. The exact threshold moves with the network's cost parameters.

A third party cannot use this against an owner. The calls come from the tree the owner signs.

**Who is affected.** A contract author who expects a Paso account to pass tens of kilobytes as `Bytes`.

**Reproduce.**

```sh
cargo test -p paso-account f08_ -- --nocapture
```

- `f08_memory_for_a_bytes_argument_grows_with_the_square_of_its_length` prints the table and asserts that 24,000 bytes fit under the mainnet memory limit and 26,000 do not.
- `f08_call_with_a_64_kb_bytes_argument_can_never_be_authorised` enforces the mainnet limits: 8,000 bytes pass, 64,000 fail inside the signature check.

The figures come from the test environment's cost model on the compiled contract, not from mainnet transactions.

**What to do today.** Do not design a contract that expects a Paso account to pass tens of kilobytes as `Bytes`. Pass a hash, or a `String`. An integrator should reject such a call before asking for a signature, with a message that names the cause.

### F-09. The hub cannot give anything back

**Severity: Informational.** Likelihood: very low for leftovers, which need a change at Circle; low for mistaken transfers. Impact: loss of those amounts.

**What it is.** `exit` pulls `amount` to the hub, approves Circle's contract for `amount`, and asks it to burn `amount`. Circle's contract burns the part of the amount that fits its canonical decimals and leaves the rest with its caller. The hub's dust check assumes a factor of ten. That matches Circle's configuration on mainnet at the time of the review, `{local_decimals: 7, canonical_decimals: 6}`, which Circle's token controller can change.

The hub has no function that moves its own balance, and it cannot be named as `from` in `exit`: nothing can authorise for the hub's own address. If Circle ever takes less than `amount`, the difference stays in the hub for good; a later `exit` neither sweeps nor refunds it. The same holds for USDC sent to the hub by mistake, and the hub's address is in every exit prompt, as `contract` and as the destination of the nested `transfer`.

The hub's balance on mainnet was 0 at the time of the review. "The hub holds nothing between calls" is true while Circle takes the full amount, and is not enforced by anything.

**Who is affected.** Anyone who sends USDC to the hub's address, and every user of `exit` if Circle changes its decimal configuration.

**Reproduce.**

```sh
cargo test -p paso-hub f09_
```

- `f09_hub_keeps_for_good_what_the_messenger_leaves_and_what_is_sent_to_it`: the stand-in is told to leave 100 units of every amount with its caller.
- `f09_hub_cannot_exit_its_own_balance`

Circle's configuration and the hub's balance on mainnet:

```sh
stellar contract invoke --id CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL \
  --source-account GAS65I36DQSMBSEZRN5KXDJMRCNEWNEX2VANOQB2QZQX5JX2X6D4SQBM \
  --rpc-url $RPC --network-passphrase "$NET" --send=no \
  -- get_token_decimal_config --local_token CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75

stellar contract invoke --id CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75 \
  --source-account GAS65I36DQSMBSEZRN5KXDJMRCNEWNEX2VANOQB2QZQX5JX2X6D4SQBM \
  --rpc-url $RPC --network-passphrase "$NET" --send=no \
  -- balance --id CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK
```

**What to do today.** Never send anything to the hub's address. It is not a deposit address. An integrator should read Circle's decimal configuration before an exit and stop if it is not `7` and `6`.

### F-10. The hub checks sign and dust only

**Severity: Informational.** Likelihood: low. Impact: none on chain for the cases Circle rejects; permanent loss for a recipient that cannot be minted to.

**What it is.** `exit` requires a positive amount, a non-negative fee cap, both within `i64` and both multiples of ten. Everything else goes to Circle as given. What Circle's contract does with it, according to its published source:

| Input | Circle's contract | Result |
|---|---|---|
| `max_fee ≥ amount` | Refuses | Reverts, nothing moves |
| Fee cap below the minimum fee | Refuses; the minimum fee was 0 on mainnet at the time of the review | Reverts |
| Zero recipient | Refuses | Reverts |
| Domain with no registered messenger, Stellar's own domain included | Refuses | Reverts |
| Amount above the burn limit, 10,000,000 USDC per message on mainnet | Refuses | Reverts |
| `min_finality_threshold`, any value | Not validated on Stellar | Passed into the message |
| A recipient that is not a valid destination on the chosen domain | Not validated | Burned on Stellar; if it cannot be minted there, lost |

The last row is the one that costs money. Domain 5 (Solana) is registered on mainnet, and there the recipient has to be a token account. A 20-byte Ethereum address padded to 32 bytes is not one. An exit to a non-EVM domain with an EVM-shaped recipient burns USDC that cannot be minted.

Two smaller points. The `Exit` event carries no fee cap and no finality threshold, and its `amount` is the amount burned, not the amount that arrives. And since anyone can call `exit`, an indexer must not read `from` as "a Paso account".

**Who is affected.** An integrator who passes a destination domain or a recipient the hub was not built around, and that integrator's users.

**Reproduce.** `f10_hub_forwards_fee_cap_recipient_domain_and_finality_unchecked`:

```sh
cargo test -p paso-hub f10_
```

The test shows what the hub forwards. What Circle's contract then does is read from its source, not tested against its code.

**What to do today.** Use the hub for EVM destinations only. Take the delivered amount from Circle, not from the `Exit` event.

### F-11. The signature does not bind the credential wrapper or the spelling of the recovery byte

**Severity: Informational.** Impact: none found.

**What it is.**

- The credential encodings `AddressV2` and `AddressWithDelegates` hash to the same payload. A signature made for a V2 entry still verifies after anyone re-wraps the entry with a list of delegates. The account never consults delegates, the host does not require them to be used, and the nonce is consumed all the same. The same call runs once.
- The same `(r, s)` is accepted with a last byte of 27 or 0, and of 28 or 1. One signature has two valid 65-byte forms.

Neither changes what is authorised or how often. Replay protection is the nonce, not the bytes of the signature. The mirrored (high-`s`) form of a signature is refused. "Signatures are not malleable", as the project's documents used to say, was wider than what the code does: low `s` is enforced, and the signature bytes are still not unique.

**Who is affected.** Anyone who uses the bytes of a signature or of a signed entry as an identifier: a fee payer that deduplicates requests by hashing them will see the two spellings as two requests. The nonce still stops the second from running.

**Reproduce.**

```sh
cargo test -p paso-account f11_
```

- `f11_signature_still_verifies_after_anyone_rewraps_the_entry_with_delegates`
- `f11_one_signature_has_two_accepted_65_byte_spellings`, and `accepts_v_0_1_and_27_28` in `test.rs`

**What to do today.** Nothing for an owner. Do not use the bytes of a Paso signature or of a signed entry as an identifier.

### F-12. Used as a delegated signer, the `account` field names the signer

**Severity: Informational.** Likelihood: low; no deployed account is known to delegate to a Paso account. Impact: a prompt that reads as "my account" while another account's authority is used.

**What it is.** Protocol 29 lets a custom account forward its signature payload and contexts to another address's `__check_auth`. A Paso account works as such a delegate with no change. In that case `payload` and `calls` belong to the outer account, and `account`, which the contract fills with its own address, is the Paso account.

The owner then signs a message that says `account: <my Paso account>` while authorising calls for a different account. Only the argument values and the opaque payload say so. The contract cannot tell the two uses apart and cannot name the outer account: the host passes it nothing but the payload hash and the contexts.

A signature does not cross between the two uses. The outer account's address is inside the payload (N-03).

**Who is affected.** The owner of a Paso account that has been registered as a signer of another account.

**Reproduce.** `f12_as_a_delegated_signer_the_account_field_names_the_signer_not_the_spender`:

```sh
cargo test -p paso-account f12_
```

**What to do today.** `account` means "the contract that checks the signature". If your Paso account is ever a signer for another account, read the arguments, not the `account` line. Anyone who registers a Paso account as a signer of another account should build the prompt with this in mind.

### F-13. A `String` that starts with a byte-order mark must be hashed with the mark

**Severity: Informational.** Likelihood: very low. Impact: such a call fails with `BadSignature`; nothing is accepted that should not be.

**What it is.** The contract hashes the bytes of a `String` as they are. A signer has to hash the same bytes. JavaScript's `TextDecoder` drops a leading U+FEFF unless it is created with `ignoreBOM: true`: the bytes `ef bb bf 68 69` decode to `hi`, which encodes back to `68 69`. A signer that renders a `String` argument that way signs text the contract will not rebuild. The failure is closed. A `String` that is not UTF-8 at all cannot be put in a typed-data request.

**Who is affected.** Whoever writes a signer. An owner sees a failed call, not a wrong one.

**Reproduce.** `f13_contract_hashes_a_byte_order_mark_and_non_utf8_bytes_exactly_as_given`:

```sh
cargo test -p paso-account f13_
```

The test signs over the exact bytes and is accepted, then signs over the text with the mark dropped and is refused.

**What to do today.** A signer has to decode `String` bytes without dropping anything: in JavaScript, `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`.

## Hypotheses tested and rejected

Each of these is an attack that was tried, or a failure that was looked for, and did not hold.

| Id | Hypothesis | How it was tested |
|---|---|---|
| N-01 | A crafted signature (zero or out-of-range scalar, high `s`, bad recovery id, `r` off the curve) does something worse than fail | Tests |
| N-02 | A signature made elsewhere (`personal_sign`, another EIP-712 domain, an EVM transaction, an EIP-7702 authorisation) collides with a Paso digest | Excluded by the leading bytes of the preimage; tests for `personal_sign` and other domains |
| N-03 | A signature moves between accounts, networks, credential encodings or direct and delegated use | Tests |
| N-04 | The calls shown to `__check_auth` can differ from what `payload` commits to; the list can be empty; a contract creation can slip through | Read from the host; tests |
| N-05 | Someone deploying your account before you, or a salt collision, gives them anything | Tests |
| N-06 | The hub's allowance to Circle's contract can be used by a third party, or survives the ledger | Test against a stand-in; Circle's side read from its source |
| N-07 | Re-entrancy through the token or the messenger | Test |
| N-08 | The deployed instances were configured differently from the repository, or can be changed | Rebuilt and compared; read from mainnet; tests |
| N-09 | A third party can make an owner's legitimate `__check_auth` run out of resources | By construction; cost measured |
| N-10 | Archival strands funds for good | Read from the protocol's rules. Not tested. |

```sh
cargo test -p paso-account n0
cargo test -p paso-hub n0
```

**N-01. Crafted signatures.** `r = 0`, `r ≥ n`, `s = 0` and `s > n/2` are refused in the contract, compared as equal-length big-endian byte strings; the host refuses them again. Only the recovery bytes 0, 1, 27 and 28 are accepted, so recovery ids 2 and 3 are unreachable. An `r` that is in range but is not the x-coordinate of a curve point makes the host's key recovery fail, which fails the authorisation and changes no state; `__check_auth` writes nothing. There is no "recovered zero address" case: a failed recovery aborts, it does not return a value to compare. A signature of the wrong length does not convert to the contract's 65-byte type. `__check_auth` cannot be invoked directly, because the host reserves function names that start with `__`. Tests: `rejects_high_s`, `rejects_out_of_range_r_and_s`, `rejects_v_2`, `rejects_flipped_recovery_id`, `rejects_signature_of_the_wrong_length`, `never_accepts_an_arbitrary_r` in `test.rs`, and `n01_r_off_the_curve_fails_in_the_host_and_r_on_the_curve_recovers_a_stranger` in `audit.rs`, which separates the two ways of failing.

**N-02. Signatures made elsewhere.** The Paso preimage is `0x19 0x01 ‖ domainSeparator ‖ structHash`. A `personal_sign` preimage starts `0x19 0x45`. A legacy transaction's signing preimage starts with an RLP list byte, `0xc0` or above; typed transactions start `0x01` to `0x04`; an EIP-7702 authorisation starts `0x05`. A collision needs a keccak256 collision. Another EIP-712 domain gives another separator unless it copies name, version, salt and types exactly, which is the hostile-front-end case of F-03 and not a collision. Tests: `n02_personal_sign_digest_is_never_a_paso_digest` has the owner `personal_sign` four texts an attacker would choose (the Paso digest as bytes and as hex text, the 66-byte preimage, and the preimage without its prefix), each refused; `n02_signature_under_another_eip712_domain_is_refused` tries another version, another name, another salt and a `chainId` domain. The transaction and EIP-7702 cases rest on the prefix argument and have no test.

**N-03. Replay.**

| Across | What stops it | Test |
|---|---|---|
| Accounts | `account` is the checking contract's address. Under the address-bound encoding the payload includes the address as well. | `rejects_other_account` |
| Networks | `salt`, and the network id inside `payload` | `rejects_other_network` |
| Calls, contracts, arguments | The text and the payload | `rejects_changed_argument`, `rejects_changed_recipient`, `rejects_changed_contract_or_function`, `rejects_added_call`, `rejects_removed_call`, `rejects_reordered_calls` |
| Time | The host's nonce and expiry | `f02_signature_is_live_through_its_expiry_ledger_and_dead_in_the_next`, `twin_signature_cannot_be_replayed_or_stretched` |
| Credential encodings | The legacy preimage has no address and a different envelope type | `n03_signature_does_not_move_between_credential_encodings` |
| Direct and delegated use | The outer account's address is in the payload | By construction; the delegated path runs in the F-12 test |

The payload is the sha256 of the authorisation preimage: network id, nonce, expiry ledger and the full invocation tree, plus the account address for the address-bound encodings. Both encodings are accepted on chain. The address-bound one adds nothing this contract needs, because `eip712.rs` binds the account itself.

**N-04. Calls and payload.** The host derives both from the same authorised invocation tree: the payload from its XDR, the list of calls from a pre-order walk of it. They cannot diverge. The walk always includes the root, so the list is never empty. Any entry that is not a contract call returns `UnsupportedContext`, in any position. This is read from the host's source. Tests: `rejects_create_contract_context`, `host_lists_contexts_root_first_then_depth_first`.

**N-05. Deploying someone's account.** The address comes from the hub and the salt; the salt is twelve zero bytes and the owner, which is injective; the constructor gets the same owner. Whoever deploys pays for the deployment the owner wanted, and a second call returns the address. Tests: `n05_deploying_an_account_before_its_owner_gives_the_deployer_nothing`, `deploy_is_idempotent`, `deploy_needs_no_authorization`, `deployed_account_has_owner`, `address_matches_the_off_chain_derivation`.

**N-06. The allowance.** The hub approves Circle's contract for the exact amount with an expiry of the current ledger; the token reads the allowance as zero from the next ledger on, and a transaction is applied within one ledger. Only Circle's contract is the spender. Tests: `n06_unused_allowance_is_out_of_a_third_partys_reach_and_ends_with_the_ledger`, and `exit_pulls_and_burns`, which finds the allowance at zero after an ordinary exit. That Circle's contract spends only inside `deposit_for_burn`, which needs the hub's own authorisation, is read from its source.

**N-07. Re-entrancy.** The host refuses to re-enter a contract that is on the call stack. The hub makes plain calls: any failure in the token or in Circle's contract reverts the whole `exit`. USDC is the built-in asset contract and calls nobody. Test: `n07_messenger_cannot_call_back_into_the_hub_during_an_exit`.

**N-08. Deployment and immutability.** A local build gives the two hashes at the top of this document. On mainnet the hub runs `aeaa1c72…b045`; the example account runs `2ee1ac08…75ee`, stores the owner `0x20806157d9607050204bbbCd37CE71498B35D46c`, and is the address `hub.address_of` returns for that owner. The hub's stored configuration is the account code `2ee1ac08…75ee`, the USDC contract `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` and Circle's messenger `CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL`, the same as [`deployments/mainnet.json`](../deployments/mainnet.json). The USDC id is the asset contract of `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`. Neither compiled contract imports the host function that replaces a contract's code, and the account imports no contract call and no `require_auth`. The interfaces on chain are three functions and four functions, as documented. Tests: `n08_account_code_cannot_replace_itself_or_call_another_contract`, `n08_hub_code_cannot_replace_itself`. The hub's stored configuration:

```sh
stellar ledger entry fetch contract-data \
  --contract CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK --instance \
  --rpc-url $RPC --network-passphrase "$NET" --output json-formatted
```

**N-09. Starving an owner's check.** Nothing a third party controls enters an owner's `__check_auth`: the calls come from the tree the owner signs. A typical exit costs 3.4 M instructions and 1.25 MB there, under 1 % and about 3 % of the limits (`f08_memory_for_a_bytes_argument_grows_with_the_square_of_its_length`).

**N-10. Archival.** A way for archival to lose funds was looked for: an account whose instance, code or balance entry is archived, deployed or not. Each is restored by anyone; only temporary entries (nonces, allowances) are ever deleted. `deploy` cannot run over an archived instance, because a transaction that touches an archived entry must restore it. This relies on the protocol's rule that an archived persistent entry can be restored and not recreated. That rule was read, not tested. F-05 says what archival does cost.

## What a fee payer and a front end can and cannot do

Given only these contracts:

| | Can | Cannot |
|---|---|---|
| Relayer or any fee payer | Refuse. Choose when, up to the expiry, a signed entry lands. Resubmit an entry from a failed transaction (F-02). Run the signed call inside a transaction of its own making, with its own calls before and after. Re-wrap the credential (F-11). | Change a call, an argument, the order or the number of calls. Use an entry twice. Use it for another account or network. Authorise anything itself. |
| Front end | Choose every call, the nonce and the expiry, including an expiry years away (F-02). Show a harmful call truthfully. Hide meaning in what has no text (F-04, F-07). Ask for a mainnet signature under a testnet story (F-03). Keep a signature and use it later. | Have the wallet show one set of calls and the account accept another. Reuse or move a signature. Create an account with another owner. |

## What the tests do not cover

Twelve gaps were found in the contract tests. The tests of this review close five of them and half of a sixth. Six stay open.

| # | Gap | Now |
|---|---|---|
| 1 | The credential encoding every live transaction uses (`AddressV2`) was not tested in the contracts, nor `AddressWithDelegates` | Closed: the `f02`, `f11`, `f12` and `n03` account tests use them |
| 2 | Vectors use stand-in payloads. No offline test derives a payload from an entry in both languages and compares | Open |
| 3 | No test of time: the expiry boundary, an expiry beyond `max_entry_ttl`, a failed transaction resubmitted, nonce reuse | Closed: the four `f02` tests |
| 4 | No resource test | Closed: the two `f08` tests |
| 5 | The hub is tested against a stand-in for Circle's contract. No test runs Circle's code: none for a paused messenger, the minimum fee, the burn limit, an unknown domain, a zero recipient, or a fee cap at or above the amount | Open. The stand-in now covers a partial burn and a denylisted caller |
| 6 | No test with a classic (`G…`) account calling `exit` | Open |
| 7 | No adversarial strings: control characters, bidirectional overrides, a byte-order mark, invalid UTF-8 | Closed for the contract: `f07_string_arguments_reach_the_wallet_with_control_characters_intact`, `f13_contract_hashes_a_byte_order_mark_and_non_utf8_bytes_exactly_as_given` |
| 8 | No property or differential test | Half closed: the contract's renderer against a second one on generated values. The SDK's renderer against the contract on generated values is open |
| 9 | No test with two entries for one account in one transaction | Open |
| 10 | No archival or restore test | Open |
| 11 | No wallet has rendered this typed data. Every statement about display, here and in the project's other documents, is about the message, not about a screen | Open |
| 12 | `never_accepts_an_arbitrary_r` asserts only that 48 inputs fail, not how | Closed: `n01_r_off_the_curve_fails_in_the_host_and_r_on_the_curve_recovers_a_stranger` |

## Limits of this review

- It was done by the project, on the project's own code. Nobody outside has checked it.
- No wallet extension and no hardware wallet was used. What MetaMask or a Ledger shows for this typed data is not known.
- Circle's contracts were read from the `master` branch of Circle's `stellar-cctp` repository as of 2026-10-12. The code deployed at Circle's addresses was not compared with that source, and Circle can upgrade it.
- The SDK, the relayer and the web app were read as context, not reviewed.
- Resource figures come from the test environment's cost model on the compiled contract, not from mainnet transactions.
- Restoring an archived entry was not exercised. The restore cost in F-05 is an estimate; the extension costs are simulated.
- Statements about the Soroban host come from reading `soroban-env-host` 29.0.0 and from the tests that go through it. A later protocol version can behave differently.

## Statements this review corrected

| Statement | Now reads |
|---|---|
| Every Ethereum address has a Stellar account you can pay | Only an address controlled by a plain key can ever spend from its account. What is sent to the account of a contract address is lost (F-01). |
| Signatures are not malleable | The mirrored (high-`s`) form is refused. The recovery byte has two accepted spellings and the credential encoding is not signed, so the signature bytes are not unique. Neither affects what is authorised or how often (F-11). |
| A signature is used once, before its expiry | Add: the expiry has no upper bound, a transaction that fails does not use the signature up, and it cannot in practice be cancelled (F-02). |
| Archived entries are restored automatically by the network when used | The shared code lives until about 9 February 2027 unless someone extends it. Restoring is permissionless, costs XLM, and the hosted relayer does not do it (F-05). |
| A vector, map or struct argument appears as a hash | So do muxed addresses, and with them the recipient of a transfer; 256-bit integers; timepoints; durations (F-04). |
| The hub holds nothing between calls | True while Circle takes the full amount. The hub cannot return anything sent to it (F-09). |
| (absent) | Every exit reaches Circle as the hub. A denylist entry or a freeze on the hub stops `exit` for all accounts (F-06). |
| The EVM chain the wallet is connected to does not matter | Add: the prompt does not name the Stellar network either; only the salt and the addresses differ (F-03). |
| (absent) | `String` bytes are not escaped, and a `Bytes` argument above about 25 kB cannot be authorised (F-07, F-08). |

[SECURITY.md](SECURITY.md) has the threat model with these findings folded in. [CLAIMS.md](CLAIMS.md) lists what is and is not claimed.
