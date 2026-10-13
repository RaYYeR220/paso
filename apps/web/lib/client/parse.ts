import { StrKey } from "@stellar/stellar-sdk";
import { getAddress, isAddress, type Address } from "viem";
import { normalize } from "viem/ens";

/** What someone typed where an Ethereum address is expected. */
export type ParsedOwner =
  | { kind: "empty" }
  | { kind: "address"; address: Address }
  | { kind: "ens"; name: string }
  | { kind: "invalid"; reason: string };

/** What someone typed as the recipient of a transfer: Stellar addresses are accepted too. */
export type ParsedRecipient = ParsedOwner | { kind: "stellar"; address: string };

const invalid = (reason: string): { kind: "invalid"; reason: string } => ({ kind: "invalid", reason });

function parseEvmAddress(input: string): ParsedOwner {
  if (!/^0x[0-9a-fA-F]*$/.test(input)) return invalid("An Ethereum address is 0x followed by hex digits");
  if (input.length !== 42) return invalid("An Ethereum address has 40 hex digits after 0x");
  const body = input.slice(2);
  const singleCase = body === body.toLowerCase() || body === body.toUpperCase();
  // A mixed-case address carries a checksum. One that does not match is a typo, and funds follow typos.
  if (!singleCase && !isAddress(input, { strict: true })) {
    return invalid("The checksum of this address does not match; check it for a typo");
  }
  return { kind: "address", address: getAddress(`0x${singleCase ? body.toLowerCase() : body}`) };
}

function parseEnsName(input: string): ParsedOwner {
  if (!/^[^\s.]+(\.[^\s.]+)+$/.test(input)) return invalid("Enter an Ethereum address (0x…) or an ENS name");
  try {
    return { kind: "ens", name: normalize(input) };
  } catch {
    return invalid("That is not a valid ENS name");
  }
}

/** Reads an Ethereum address or an ENS name. Never touches the network. */
export function parseOwnerInput(text: string): ParsedOwner {
  const input = text.trim();
  if (!input) return { kind: "empty" };
  if (/^0x/i.test(input)) return parseEvmAddress(`0x${input.slice(2)}`);
  if (input.includes(".")) return parseEnsName(input);
  return invalid("Enter an Ethereum address (0x…) or an ENS name");
}

/**
 * Reads a transfer recipient: a Stellar address (`G…` or `C…`), or an
 * Ethereum address or ENS name, which stand for that address's Stellar
 * account.
 */
export function parseRecipient(text: string): ParsedRecipient {
  const input = text.trim();
  if (/^[GCM][A-Z2-7]{20,}$/.test(input)) {
    if (StrKey.isValidEd25519PublicKey(input) || StrKey.isValidContract(input)) {
      return { kind: "stellar", address: input };
    }
    if (input.startsWith("M")) {
      return invalid("A wallet can show a muxed address (M…) only as a hash, so it is not taken as a recipient. Enter the G… address it stands for");
    }
    return invalid("That Stellar address is not valid; check it for a typo");
  }
  const parsed = parseOwnerInput(input);
  if (parsed.kind === "invalid" && !/^0x/i.test(input) && !input.includes(".")) {
    return invalid("Enter a Stellar address (G… or C…), an Ethereum address (0x…) or an ENS name");
  }
  return parsed;
}

/** A route parameter as the visitor wrote it: decoded when it can be, left alone when it cannot. */
export function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
