import { Address, Contract, StrKey, xdr } from "@stellar/stellar-sdk";
import { hexToBigInt, hexToBytes, hexToNumber, isHex, size, slice, toHex, type Hex } from "viem";
import type { InboundRoute } from "./evm";
import { resolveNetwork, type Network } from "./networks";

/** Circle's finality thresholds: attest at soft finality (seconds) or at hard finality (minutes). */
export const FAST_FINALITY = 1000;
export const STANDARD_FINALITY = 2000;

const DEFAULT_POLL_INTERVAL_MS = 2000;
const FEE_HEADROOM_DIVISOR = 5n;

/**
 * The fee Circle charges for a burn between two domains, in basis points of
 * the amount. Fractions are possible (`1.3`).
 */
export async function fetchBurnFee(
  sourceDomain: number,
  destinationDomain: number,
  network: Network,
  options: { finalityThreshold?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const { finalityThreshold = FAST_FINALITY, signal } = options;
  const url = `${resolveNetwork(network).irisUrl}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Iris answered ${response.status} for the burn fee (${url})`);
  }
  const fees = (await response.json()) as { finalityThreshold: number; minimumFee: number }[];
  const fee = Array.isArray(fees) ? fees.find((entry) => entry.finalityThreshold === finalityThreshold) : undefined;
  if (!fee || typeof fee.minimumFee !== "number") {
    throw new Error(`Iris lists no burn fee for finality ${finalityThreshold} (${url})`);
  }
  return fee.minimumFee;
}

/**
 * The `maxFee` to burn with for a fee quoted in basis points: the fee rounded
 * up, plus a fifth of headroom. Circle charges the fee in force when it
 * attests, never more than this cap; a cap below that fee turns a fast
 * transfer into a slow one.
 */
export function maxFeeFor(amount: bigint, feeBps: number): bigint {
  const hundredthsOfBps = BigInt(Math.round(feeBps * 100));
  const fee = (amount * hundredthsOfBps + 999_999n) / 1_000_000n;
  return fee + (fee + FEE_HEADROOM_DIVISOR - 1n) / FEE_HEADROOM_DIVISOR;
}

export type AttestationStatus =
  /** Iris has not indexed the burn yet. */
  | { state: "not_found" }
  /** Iris has the burn and is waiting for finality. `delayReason` says why a fast transfer is held back. */
  | { state: "pending"; delayReason?: string }
  /** Iris could not be reached or answered with an error; polling continues. */
  | { state: "unreachable"; detail: string }
  | { state: "complete" };

export interface Attestation {
  /** The CCTP message to deliver on the destination chain. */
  message: Hex;
  attestation: Hex;
  /** The message nonce the destination marks as used. */
  nonce: Hex;
}

export interface WaitForAttestationOptions {
  signal?: AbortSignal;
  /** Called after every poll, so a tracker can show what is happening. */
  onStatus?: (status: AttestationStatus) => void;
  intervalMs?: number;
}

interface IrisMessage {
  message?: string;
  attestation?: string | null;
  status?: string;
  delayReason?: string | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollIris(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: AttestationStatus; attestation?: Attestation }> {
  let body: { messages?: IrisMessage[] };
  try {
    const response = await fetch(url, { signal });
    if (response.status === 404) return { status: { state: "not_found" } };
    if (!response.ok) return { status: { state: "unreachable", detail: `Iris answered ${response.status}` } };
    body = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: { state: "unreachable", detail: error instanceof Error ? error.message : String(error) } };
  }

  const first = body.messages?.[0];
  if (!first) return { status: { state: "not_found" } };

  const { message, attestation, status, delayReason } = first;
  if (status === "complete" && isHex(message) && isHex(attestation) && size(message) >= NONCE_END) {
    return {
      status: { state: "complete" },
      attestation: { message, attestation, nonce: slice(message, NONCE_START, NONCE_END) },
    };
  }
  return { status: delayReason ? { state: "pending", delayReason } : { state: "pending" } };
}

/**
 * Asks Iris once about the burn in `txHash`. `attestation` is present when
 * the status is `complete`; every other status means: ask again later.
 */
export function fetchAttestation(
  sourceDomain: number,
  txHash: string,
  network: Network,
  options: { signal?: AbortSignal } = {},
): Promise<{ status: AttestationStatus; attestation?: Attestation }> {
  return pollIris(messagesUrl(sourceDomain, txHash, network), options.signal);
}

function messagesUrl(sourceDomain: number, txHash: string, network: Network): string {
  return `${resolveNetwork(network).irisUrl}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
}

/**
 * Polls Iris until the burn in `txHash` is attested.
 *
 * It never gives up on its own: a missing message, a pending attestation and
 * an unreachable Iris are all reported through `onStatus` and polled again.
 * Abort it through `signal`.
 */
export async function waitForAttestation(
  sourceDomain: number,
  txHash: string,
  network: Network,
  options: WaitForAttestationOptions = {},
): Promise<Attestation> {
  const { signal, onStatus, intervalMs = DEFAULT_POLL_INTERVAL_MS } = options;
  const url = messagesUrl(sourceDomain, txHash, network);

  for (;;) {
    signal?.throwIfAborted();
    const { status, attestation } = await pollIris(url, signal);
    onStatus?.(status);
    if (attestation) return attestation;
    await sleep(intervalMs, signal);
  }
}

/** Byte offsets inside a CCTP v2 message, and inside the burn message it carries as its body. */
const SOURCE_DOMAIN_START = 4;
const DESTINATION_DOMAIN_START = 8;
const NONCE_START = 12;
const NONCE_END = 44;
const DESTINATION_CALLER_START = 108;
const BODY_START = 148;
const MINT_RECIPIENT_START = BODY_START + 36;
const AMOUNT_START = BODY_START + 68;
const MAX_FEE_START = BODY_START + 132;
const FEE_EXECUTED_START = BODY_START + 164;
const HOOK_DATA_START = BODY_START + 228;

export interface BurnMessage {
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  destinationCaller: Hex;
  mintRecipient: Hex;
  /** Amount burned, in 6-decimal units whatever the chains involved. */
  amount: bigint;
  maxFee: bigint;
  /** Fee Circle kept, in 6-decimal units; the recipient is minted `amount - feeExecuted`. */
  feeExecuted: bigint;
  hookData: Hex;
}

/** Reads the fields of an attested CCTP v2 burn message. */
export function decodeBurnMessage(message: Hex): BurnMessage {
  if (size(message) < HOOK_DATA_START) {
    throw new Error(`${size(message)} bytes is too short to be a CCTP burn message`);
  }
  const word = (start: number) => slice(message, start, start + 32);
  return {
    sourceDomain: hexToNumber(slice(message, SOURCE_DOMAIN_START, SOURCE_DOMAIN_START + 4)),
    destinationDomain: hexToNumber(slice(message, DESTINATION_DOMAIN_START, DESTINATION_DOMAIN_START + 4)),
    nonce: slice(message, NONCE_START, NONCE_END),
    destinationCaller: word(DESTINATION_CALLER_START),
    mintRecipient: word(MINT_RECIPIENT_START),
    amount: hexToBigInt(word(AMOUNT_START)),
    maxFee: hexToBigInt(word(MAX_FEE_START)),
    feeExecuted: hexToBigInt(word(FEE_EXECUTED_START)),
    hookData: size(message) > HOOK_DATA_START ? slice(message, HOOK_DATA_START) : "0x",
  };
}

/** Which inbound route a burn used: it mints either to Circle's forwarder or straight to the recipient. */
export function inboundRouteOf(message: Hex, network: Network): InboundRoute {
  const forwarder = toHex(StrKey.decodeContract(resolveNetwork(network).stellar.forwarder));
  return decodeBurnMessage(message).mintRecipient === forwarder ? "forwarder" : "direct";
}

const bytes = (value: Hex): xdr.ScVal => xdr.ScVal.scvBytes(hexToBytes(value));

/**
 * `CctpForwarder.mint_and_forward(message, attestation)`: mints to the
 * forwarder and passes the USDC on to the recipient named in the hook data.
 * Anyone can submit it.
 */
export function mintAndForwardOperation(message: Hex, attestation: Hex, network: Network): xdr.Operation {
  const { forwarder } = resolveNetwork(network).stellar;
  return new Contract(forwarder).call("mint_and_forward", bytes(message), bytes(attestation));
}

/**
 * `MessageTransmitter.receive_message(caller, message, attestation)`: mints
 * straight to the recipient in the message. `caller` must authorise the call,
 * which it does by being the transaction source.
 */
export function receiveMessageOperation(
  caller: string,
  message: Hex,
  attestation: Hex,
  network: Network,
): xdr.Operation {
  const { messageTransmitter } = resolveNetwork(network).stellar;
  return new Contract(messageTransmitter).call(
    "receive_message",
    new Address(caller).toScVal(),
    bytes(message),
    bytes(attestation),
  );
}

/** The delivery operation for an attested burn, chosen by the route the burn used. */
export function deliverOperation(
  delivery: { message: Hex; attestation: Hex; caller: string },
  network: Network,
): xdr.Operation {
  const { message, attestation, caller } = delivery;
  return inboundRouteOf(message, network) === "forwarder"
    ? mintAndForwardOperation(message, attestation, network)
    : receiveMessageOperation(caller, message, attestation, network);
}
