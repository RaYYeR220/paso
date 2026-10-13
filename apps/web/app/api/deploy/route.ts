import { admit, respond } from "@/lib/server/http";
import { clientIdentity } from "@/lib/server/ratelimit";
import { getRelayer } from "@/lib/server/relayer";

export const maxDuration = 60;

/**
 * Deploys the Stellar account of an Ethereum address. Testnet only.
 *
 *   POST { network: "testnet", owner }
 *   200  { address, hash, alreadyDeployed: false }   deployed by this request
 *   200  { address, alreadyDeployed: true }          it was there already
 *   404  { error: "not_found" }                      on mainnet
 *
 * The account can receive USDC before it is deployed, and the relay route
 * deploys it before a first call, so this is only needed to deploy early.
 * On mainnet the relayer pays for a deployment only together with the
 * owner's first signed call, after checking the signature; a bare request
 * here proves nothing about who asks.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    const { body, network } = await admit("deploy", request);
    return getRelayer(network).deploy(body, clientIdentity(request));
  });
}
