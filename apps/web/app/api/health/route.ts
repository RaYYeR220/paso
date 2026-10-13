import { connection } from "next/server";
import { limit, respond } from "@/lib/server/http";
import { serverHealth } from "@/lib/server/relayer";

/**
 * What the server works on and what its accounts hold, one report per
 * network:
 *
 *   200 { ok, default, networks: { testnet, mainnet } }
 *
 * A network the server works on reports `enabled: true`, its hub, the
 * relayer's address and XLM, what is left of the day's fee budget, the caps
 * on a transaction and on a caller, and the payer's address and balances on
 * Base. One it does not work on reports `enabled: false` and nothing else.
 * Addresses, balances and limits only.
 */
export async function GET(request: Request): Promise<Response> {
  await connection();
  return respond(async () => {
    limit("health", request);
    return serverHealth();
  });
}
