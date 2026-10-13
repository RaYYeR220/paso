/**
 * Reading Circle's side of a transfer: what Iris attested for a transaction,
 * and where an attested message sends its USDC.
 */
import { StrKey, xdr, type rpc } from "@stellar/stellar-sdk";
import { getAddress, hexToBytes, hexToNumber, hexToString, size, slice, type Address, type Hex } from "viem";
import {
  decodeBurnMessage,
  fetchAttestations,
  inboundRouteOf,
  readContract,
  renderArg,
  type Attestation,
  type NetworkConfig,
} from "../packages/sdk/src/index";
import type { Report } from "./sender";

const POLL_MS = 2000;
/** How long a hash Iris has never heard of is asked about again: a burn just made takes a moment to show. */
const NOT_FOUND_MS = 60_000;
/** How long an attestation is waited for. A fast transfer takes seconds, a standard one up to about twenty minutes. */
const ATTESTATION_TIMEOUT_MS = 25 * 60_000;

/**
 * The messages Iris attested for the transaction `txHash` on `sourceDomain`.
 *
 * With `wait`, a burn Iris has not attested yet is asked about until it is,
 * and each change of state is reported. Without it Iris is asked once, and
 * `undefined` comes back when the answer is not an attestation yet.
 */
export async function attestedMessages(
  sourceDomain: number,
  txHash: string,
  config: NetworkConfig,
  options: { wait: boolean; report: Report },
): Promise<Attestation[] | undefined> {
  const { wait, report } = options;
  const started = Date.now();
  let last = "";
  for (;;) {
    const found = await fetchAttestations(sourceDomain, txHash, config);
    if (found.state === "complete") return found.attestations;
    if (found.state === "malformed") {
      throw new Error(`Iris answered for ${txHash} with something that is not an attestation: ${found.detail}`);
    }
    const elapsed = Date.now() - started;
    const text =
      found.state === "pending"
        ? `pending${found.delayReason ? ` (${found.delayReason})` : ""}: the burn is known and not attested yet`
        : found.state === "unreachable"
          ? `unreachable: ${found.detail}`
          : "has no burn under this hash yet";
    if (text !== last) {
      report("circle", `${text}${wait ? `, after ${Math.round(elapsed / 1000)} s` : ""}`);
      last = text;
    }
    if (found.state === "not_found" && (!wait || elapsed > NOT_FOUND_MS)) {
      throw new Error(
        `Iris (${config.irisUrl}) knows no burn ${txHash} on CCTP domain ${sourceDomain}. ` +
          `Check the hash, and that it is a ${config.name} transaction; a burn made a moment ago shows within seconds`,
      );
    }
    if (!wait) return undefined;
    if (elapsed > ATTESTATION_TIMEOUT_MS) {
      throw new Error(`Iris has not attested ${txHash} after ${Math.round(elapsed / 60_000)} minutes. Run this again later`);
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

/**
 * The Stellar address an attested burn pays: the one named in the hook data
 * when the USDC goes through Circle's forwarder, the mint recipient itself
 * otherwise.
 */
export function stellarRecipient(message: Hex, config: NetworkConfig): string {
  const burn = decodeBurnMessage(message);
  if (inboundRouteOf(message, config) === "direct") {
    return StrKey.encodeContract(Buffer.from(hexToBytes(burn.mintRecipient)));
  }
  // 24 reserved bytes, a 4-byte version, the 4-byte length of the address, then the address as text.
  const { hookData } = burn;
  const length = size(hookData) >= 32 ? hexToNumber(slice(hookData, 28, 32)) : 0;
  const recipient = length > 0 && size(hookData) >= 32 + length ? hexToString(slice(hookData, 32, 32 + length)) : "";
  const valid =
    StrKey.isValidContract(recipient) ||
    StrKey.isValidEd25519PublicKey(recipient) ||
    StrKey.isValidMed25519PublicKey(recipient);
  if (!valid) {
    throw new Error("The message goes through Circle's forwarder, and its hook data names no Stellar address");
  }
  return recipient;
}

/** The Base address an attested exit pays: the last 20 bytes of the mint recipient. */
export function evmRecipient(message: Hex): Address {
  return getAddress(slice(decodeBurnMessage(message).mintRecipient, 12));
}

/** Whether Circle's message transmitter on Stellar has taken a message: it takes each one once. */
export async function deliveredOnStellar(config: NetworkConfig, server: rpc.Server, nonce: Hex): Promise<boolean> {
  const used = await readContract(
    config.stellar.messageTransmitter,
    "is_nonce_used",
    [xdr.ScVal.scvBytes(Buffer.from(hexToBytes(nonce)))],
    config,
    server,
  );
  return renderArg(used) === "true";
}
