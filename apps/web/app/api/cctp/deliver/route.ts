import { admit, respond } from "@/lib/server/http";
import { clientIdentity } from "@/lib/server/ratelimit";
import { getRelayer } from "@/lib/server/relayer";

export const maxDuration = 60;

/**
 * Delivers USDC burned on another chain to Stellar, once Circle has attested
 * the burn.
 *
 *   POST { network, sourceDomain, txHash }
 *     sourceDomain  CCTP domain of the chain the burn happened on (Base is 6)
 *     txHash        hash of the burn transaction
 *
 *   200 { status: "pending", attestation: "not_found" | "pending" | "unreachable", delayReason? }
 *   200 { status: "delivered", hash?, route: "forwarder" | "direct" }
 *
 *   503 { error: "unavailable", reason? }   the relayer is not delivering for now; `reason` says why
 *
 * Each request asks Circle once: call again every couple of seconds while the
 * status is `pending`. `hash` is missing when the message had already been
 * delivered by someone else, which is just as good. A burn the relayer does
 * not deliver is not lost: Circle has attested it, and anyone can deliver it
 * from any funded Stellar account, at any time.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    const { body, network } = await admit("deliver", request);
    return getRelayer(network).deliver(body, clientIdentity(request));
  });
}
