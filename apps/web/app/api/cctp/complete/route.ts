import { limit, readJson, respond } from "@/lib/server/http";
import { clientIdentity } from "@/lib/server/ratelimit";
import { getRelayer } from "@/lib/server/relayer";

export const maxDuration = 60;

/**
 * Finishes a transfer back to Base: once Circle has attested the exit, the
 * server's account on Base submits the mint and pays its gas.
 *
 *   POST { network, txHash }
 *     txHash  the Stellar transaction of the exit: 64 hex digits, no 0x
 *
 *   200 { status: "pending", attestation: "not_found" | "pending" }
 *   200 { status: "minted", hash? }
 *
 * Each request asks Circle once: call again every couple of seconds while the
 * status is `pending`. `hash` is the minting transaction on Base; it is
 * missing when the message had been received there already, which is just as
 * good. Only exits made through the hub, from Stellar to Base, are completed.
 * On mainnet the server answers 404 unless it was set up to pay for mints:
 * the mint can be submitted from any wallet.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    limit("complete", request);
    return getRelayer().complete(await readJson(request), clientIdentity(request));
  });
}
