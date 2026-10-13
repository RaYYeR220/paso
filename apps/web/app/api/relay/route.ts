import { admit, respond } from "@/lib/server/http";
import { clientIdentity } from "@/lib/server/ratelimit";
import { getRelayer } from "@/lib/server/relayer";

export const maxDuration = 60;

/**
 * Relays a call signed by the owner of an account and pays its fee.
 *
 *   POST { network, owner, func, auth }
 *     network  "testnet" or "mainnet"
 *     owner    the Ethereum address that owns the account
 *     func     base64 HostFunction XDR: one contract call
 *     auth     [ base64 SorobanAuthorizationEntry XDR ]: the account's signed entry, and only that
 *
 *   200 { hash, deployHash? }
 *   409 { error: "expired" }            the signature's last valid ledger has passed; sign again
 *   422 { error: "bad_signature" }      the account refused the signature for this call
 *   422 { error: "simulation_failed" }  the call would fail, or costs more than the relayer pays for
 *   400 { error: "bad_request" }        not one signed call from the owner's account
 *   429 { error: "rate_limited" }       this caller has had as many calls paid for as one gets in an hour
 *   503 { error: "unavailable" }        `reason` says why when the relayer is declining for now:
 *                                       not_serving, daily_budget, hourly_limit, low_balance
 *
 * Every refusal carries a `detail` sentence. The relayer of the network the
 * request names answers it; each network has its own account, limits and
 * budget.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    const { body, network } = await admit("relay", request);
    return getRelayer(network).relay(body, clientIdentity(request));
  });
}
