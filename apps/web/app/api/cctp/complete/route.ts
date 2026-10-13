import { admit, respond } from "@/lib/server/http";
import { clientIdentity } from "@/lib/server/ratelimit";
import { getRelayer } from "@/lib/server/relayer";

export const maxDuration = 60;

/**
 * Finishes a transfer back to Base. Once Circle has attested the exit, the
 * server's account on Base submits the mint and pays its gas; where the
 * server does not pay for mints, it checks the exit and hands it back for
 * the owner's wallet to submit.
 *
 *   POST { network, txHash }
 *     txHash  the Stellar transaction of the exit: 64 hex digits, no 0x
 *
 *   200 { status: "pending", attestation: "not_found" | "pending" }
 *   200 { status: "minted", hash? }
 *   200 { status: "attested", message, attestation }   checked, and the caller's to mint
 *   422 { error: "simulation_failed" }   this exit cannot be minted by the server; `detail` says why
 *
 * Each request asks Circle once: call again every couple of seconds while the
 * status is `pending`. `hash` is the minting transaction on Base; it is
 * missing when the message had been received there already, which is just as
 * good. Only exits made through the hub, from Stellar to Base, are completed,
 * and only when simulating the mint succeeds: an exit that cannot be minted
 * gets a refusal that stays the same however often it is asked about.
 *
 * On mainnet the answer for an attested exit is `attested`, unless the
 * server was set up to pay for mints there: `message` and `attestation` are
 * what Circle returned, to be handed to `receiveMessage` on Circle's
 * MessageTransmitter on Base from any wallet. The exit is checked in the
 * same way in both cases, and nothing a caller sends is passed on.
 *
 * No Stellar fee is paid here. Where the server pays for the mint, it pays
 * gas on Base, and only for an exit made through the hub: an exit the
 * account's owner signed.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(async () => {
    const { body, network } = await admit("complete", request);
    return getRelayer(network).complete(body, clientIdentity(request));
  });
}
