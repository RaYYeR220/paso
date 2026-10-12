import { connection } from "next/server";
import { respond } from "@/lib/server/http";
import { getRelayer } from "@/lib/server/relayer";

/**
 * What the server runs on and what its accounts hold: the network, the hub,
 * the relayer's address and XLM, the demo payer's address and its balances
 * on Base. Addresses and balances only.
 */
export async function GET(): Promise<Response> {
  await connection();
  return respond(() => getRelayer().health());
}
