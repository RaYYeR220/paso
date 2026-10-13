/**
 * Reading Circle's side of a transfer: what Iris attested for a transaction,
 * and where an attested message sends its USDC.
 */
import { StrKey, xdr, type rpc } from "@stellar/stellar-sdk";
import { getAddress, hexToBytes, hexToNumber, hexToString, pad, size, slice, type Address, type Hex } from "viem";
import {
  decodeBurnMessage,
  fetchAttestations,
  findBurnSource,
  inboundRouteOf,
  readContract,
  renderArg,
  type Attestation,
  type EvmChainConfig,
  type EvmChainName,
  type NetworkConfig,
} from "../packages/sdk/src/index";
import { expectSame } from "./evm";
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
 * The chain a burn on an EVM chain was made on, from its hash alone: Iris is
 * asked under the domain of every chain the network lists, or of `chains`.
 * With `wait`, a hash no chain knows yet is asked about again for a minute,
 * since a burn just made takes a moment to show.
 */
export async function burnSource(
  txHash: string,
  config: NetworkConfig,
  options: { wait: boolean; report: Report; chains?: readonly EvmChainName[] },
): Promise<EvmChainConfig> {
  const started = Date.now();
  let last = "";
  for (;;) {
    const found = await findBurnSource(txHash, config, { chains: options.chains });
    if (found.state === "found") return found.chain;
    if (found.state === "ambiguous") {
      throw new Error(`Iris has a burn ${txHash} on ${found.chains.map((chain) => chain.label).join(" and ")}: name the chain with --chain`);
    }
    const text = found.state === "unreachable" ? `unreachable: ${found.detail}` : "has no burn under this hash on any chain yet";
    if (text !== last) {
      options.report("circle", text);
      last = text;
    }
    if (found.state === "not_found" && (!options.wait || Date.now() - started > NOT_FOUND_MS)) {
      throw new Error(
        `Iris (${config.irisUrl}) knows no burn ${txHash} on any chain Paso lists for ${config.name}. ` +
          "Check the hash and the network; a burn made a moment ago shows within seconds",
      );
    }
    if (!options.wait && found.state === "unreachable") throw new Error(`Iris could not be asked: ${found.detail}`);
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

/** The EVM address an attested exit pays: the last 20 bytes of the mint recipient. */
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

/**
 * Circle's three contracts on Stellar have to name each other, carry
 * Stellar's domain, be running, and know `chain`: its token messenger for its
 * domain, and its USDC paired with Stellar's.
 */
export async function checkStellarCircle(config: NetworkConfig, server: rpc.Server, chain: EvmChainConfig, report: Report): Promise<void> {
  const { tokenMessenger, messageTransmitter, forwarder, cctpDomain, usdc } = config.stellar;
  const read = async (contract: string, fn: string, ...args: xdr.ScVal[]) =>
    renderArg(await readContract(contract, fn, args, config, server));
  const bytes32 = (value: Hex) => xdr.ScVal.scvBytes(Buffer.from(hexToBytes(value)));

  expectSame("The message transmitter of Circle's forwarder", await read(forwarder, "get_message_transmitter"), messageTransmitter);
  expectSame("The token messenger of Circle's forwarder", await read(forwarder, "get_token_messenger_minter"), tokenMessenger);
  expectSame(
    "The message transmitter of Circle's token messenger",
    await read(tokenMessenger, "get_local_message_transmitter"),
    messageTransmitter,
  );
  expectSame("Stellar's CCTP domain", await read(messageTransmitter, "get_local_domain"), String(cctpDomain));
  expectSame(
    `The token messenger Stellar knows for ${chain.label}`,
    await read(tokenMessenger, "get_remote_token_messenger", xdr.ScVal.scvU32(chain.cctpDomain)),
    pad(chain.tokenMessenger),
  );
  expectSame(
    `The Stellar USDC minted for USDC from ${chain.label}`,
    await read(tokenMessenger, "get_local_token", xdr.ScVal.scvU32(chain.cctpDomain), bytes32(pad(chain.usdc))),
    usdc,
  );
  for (const contract of [forwarder, tokenMessenger, messageTransmitter]) {
    expectSame(`Whether ${contract} is paused`, await read(contract, "paused"), "false");
  }
  report("stellar", "forwarder, token messenger and message transmitter name each other; none is paused");
  report("", `domain ${cctpDomain}, with ${chain.label} registered as domain ${chain.cctpDomain} and its USDC paired`);
}
