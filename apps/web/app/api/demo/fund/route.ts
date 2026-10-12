import { limit, readJson, respond } from "@/lib/server/http";
import { clientIdentity } from "@/lib/server/ratelimit";
import { getRelayer } from "@/lib/server/relayer";

export const maxDuration = 60;

/**
 * Testnet faucet: burns 1 test USDC on Base Sepolia for the Stellar account
 * of an Ethereum address.
 *
 *   POST { owner }
 *   200  { burnTxHash, sourceDomain, twin, amount }
 *   429  { error: "rate_limited" }   with a Retry-After header
 *   503  { error: "unavailable" }    the faucet is empty, or has given out its day's worth
 *   404  { error: "not_found" }      on any network but testnet
 *
 * Hand `sourceDomain` and `burnTxHash` to the delivery route to follow the
 * USDC to Stellar. The faucet is limited per caller, per owner and per day
 * overall. An attempt counts once it starts, whether or not it succeeds. The
 * counts are kept in memory, so they start over when the server restarts or
 * is redeployed.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    limit("fund", request);
    return getRelayer().demoFund(await readJson(request), clientIdentity(request));
  });
}
