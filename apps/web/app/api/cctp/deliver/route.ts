import { limit, readJson, respond } from "@/lib/server/http";
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
 * Each request asks Circle once: call again every couple of seconds while the
 * status is `pending`. `hash` is missing when the message had already been
 * delivered by someone else, which is just as good.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    limit("deliver", request);
    return getRelayer().deliver(await readJson(request));
  });
}
