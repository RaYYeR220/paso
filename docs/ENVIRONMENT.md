# Server environment

The web app's server reads these variables. Copy [`apps/web/.env.example`](../apps/web/.env.example) to `apps/web/.env.local`; the dev server and the web tests read that file, and so do the scripts on testnet. On mainnet the scripts read the environment alone.

One server can serve testnet and mainnet at the same time, from the same routes. Each request names its network. Each network has its own relayer account, queue, limits and daily budget.

- Testnet is served whenever `RELAYER_SECRET` is set.
- Mainnet is served only when `PASO_ALLOW_MAINNET=true` and `RELAYER_SECRET_MAINNET` are both set. Mainnet reads only variables whose names end in `_MAINNET`: nothing set up for testnet carries over to real funds. Its relayer has to be a Stellar account of its own; the testnet relayer's secret is refused. Without both variables, requests for mainnet are answered `503 { error: "unavailable", reason: "not_serving" }`.

Amounts on Stellar are in stroops, ten million to the XLM. USDC on Base is in 6-decimal units. ETH is in wei.

## The network and its accounts

| Variable | Network | Purpose | Default |
|---|---|---|---|
| `PASO_NETWORK` | both | The network a request means when it names none: `testnet` or `mainnet`. | `testnet` |
| `RELAYER_SECRET` | testnet | Secret key (`S…`) of the Stellar account that pays the fee of every relayed transaction. It pays fees and nothing else. | required |
| `DEMO_PAYER_PRIVATE_KEY` | testnet | Private key (`0x…`) of the server's account on Base Sepolia. It burns for the faucet and pays the gas of mints that finish a transfer back to Base. Empty switches both off. | none |
| `STELLAR_RPC_URL` | testnet | Soroban RPC endpoint. | the network's public endpoint |
| `BASE_RPC_URL` | testnet | RPC endpoint for Base Sepolia. | the chain's public endpoint |
| `PASO_ALLOW_MAINNET` | mainnet | Must be `true` for the server to work on mainnet at all. | off |
| `RELAYER_SECRET_MAINNET` | mainnet | Secret key (`S…`) of the Stellar mainnet account that pays the fees there. Must not be the testnet relayer's. | required for mainnet |
| `STELLAR_RPC_URL_MAINNET` | mainnet | Soroban RPC endpoint. | the network's public endpoint |
| `BASE_RPC_URL_MAINNET` | mainnet | RPC endpoint for Base. | the chain's public endpoint |

## Limits on the relayer

| Variable | What it bounds | Testnet default | Mainnet default |
|---|---|---|---|
| `RELAYER_MAX_RESOURCE_FEE` | The most one transaction may cost in resource fees, in stroops | `5000000` (0.5 XLM) | `3000000` (0.3 XLM) |
| `RELAYER_MAX_DAILY_FEES` | The most the relayer spends on fees in any 24 hours, in stroops | `500000000` (50 XLM) | `20000000` (2 XLM) |
| `RELAYER_MIN_BALANCE` | What the relayer account keeps, in stroops: nothing is sent that would take its balance below this | `0` | `20000000` (2 XLM) |
| `RELAYER_INCLUSION_FEE` | What a transaction bids to be included in a ledger, in stroops, on top of its resource fee. Doubled each time a transaction that no ledger took is sent again; at most three are sent | `1000` | `100000` (0.01 XLM) |
| `RELAYS_PER_CALLER_PER_HOUR`, `RELAYS_PER_HOUR` | Relayed calls paid for in an hour, from one caller and from everyone | `120`, `1200` | `8`, `40` |
| `DEPLOYS_PER_CALLER_PER_HOUR`, `DEPLOYS_PER_HOUR` | Account deployments paid for in an hour | `60`, `600` | `3`, `12` |
| `DELIVERIES_PER_CALLER_PER_HOUR`, `DELIVERIES_PER_HOUR` | Deliveries from Base paid for in an hour | `60`, `600` | `6`, `20` |

The mainnet variable has the same name with `_MAINNET` at the end, for example `RELAYER_MAX_RESOURCE_FEE_MAINNET`. A delivery from Base costs about 0.07 XLM and is the largest item. The limits are kept in memory by each server instance and start over when it restarts.

## Mints on Base

When a transfer back to Base has been attested, someone has to submit the mint on Base and pay its gas. Where the server does not pay, it hands the attested message back and the owner's wallet submits the mint. Anyone else can submit it too.

| Variable | Purpose | Default |
|---|---|---|
| `PAY_BASE_MINTS_ON_TESTNET` | `false` stops the server paying for mints on Base Sepolia. | the server pays |
| `PAY_BASE_MINTS_ON_MAINNET` | `true`, on top of serving mainnet, has the server pay for mints on Base. | off: the wallet submits the mint |
| `BASE_PAYER_PRIVATE_KEY_MAINNET` | Private key (`0x…`) of the server's account on Base mainnet. Needed only when the server pays. | none |
| `BASE_MINTS_PER_CALLER_PER_HOUR` | Mints the server pays the gas for, per caller in an hour. | `10` |
| `BASE_MINTS_PER_DAY` | Mints the server pays the gas for in any 24 hours, whoever asks. | `100` |
| `BASE_MINT_PAYER_ETH_FLOOR` | ETH the server's account on Base keeps, in wei. Below it the server stops paying. | `100000000000000` (0.0001 ETH) |
| `BASE_MINT_MAX_FEE_PER_GAS` | The most the server offers per unit of gas, in wei. While Base asks more, it does not mint. | `250000000` (0.25 gwei) |

The last four apply to mainnet under the same name with `_MAINNET` at the end.

## The testnet faucet

The faucet burns 1 test USDC on Base Sepolia for an owner's account. It exists on testnet only; on mainnet the route answers 404.

| Variable | Purpose | Default |
|---|---|---|
| `DEMO_FUND_PER_IP_PER_HOUR` | Requests one caller address may make per hour. | `5` |
| `DEMO_FUND_PER_OWNER_PER_DAY` | Requests for one owner per day. | `2` |
| `DEMO_FUND_PER_DAY` | Payouts in any 24 hours, whoever asks. | `50` |
| `DEMO_FUND_PAYER_FLOOR` | USDC the faucet's payer keeps, in 6-decimal units. No payout takes it below this. | `2000000` (2 USDC) |

## Tests and scripts

| Variable | Used by | Purpose |
|---|---|---|
| `PASO_E2E_OWNER_KEY` | tests, scripts | Ethereum private key (`0x…`) of an owner whose account is deployed on testnet. The scripted-wallet journey (`pnpm --filter @paso/web e2e`) signs and pays on Base with it. |
| `PASO_E2E_SOURCE_SECRET` | tests, scripts | Secret key (`S…`) of any funded Stellar testnet account. It may be the relayer's. |
| `PASO_E2E_PAYER_KEY` | scripts, optional | Ethereum private key (`0x…`) that pays the burn on Base Sepolia. Defaults to `DEMO_PAYER_PRIVATE_KEY`, then `PASO_E2E_OWNER_KEY`. |
| `PASO_E2E_NETWORK`, `PASO_E2E_BASE_URL` | the scripted-wallet journey | The network, `testnet` or `mainnet`, and the address of the site to drive. |
| `PASO_OFFLINE` | tests | `1` skips every test that reaches a network. |
