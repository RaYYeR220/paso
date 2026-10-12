import { limit, readJson, respond } from "@/lib/server/http";
import { getRelayer } from "@/lib/server/relayer";

export const maxDuration = 60;

/**
 * Deploys the Stellar account of an Ethereum address.
 *
 *   POST { network, owner }
 *   200  { address, hash, alreadyDeployed: false }   deployed by this request
 *   200  { address, alreadyDeployed: true }          it was there already
 *
 * The account can receive USDC before it is deployed, and the relay route
 * deploys it before a first call, so this is only needed to deploy early.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    limit("deploy", request);
    return getRelayer().deploy(await readJson(request));
  });
}
