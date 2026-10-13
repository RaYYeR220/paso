import { saltNetwork, type ArgConcern, type Call, type DescribedCall } from "@paso/sdk";
import type { Hex } from "viem";

/** The message a signature is about: what the wallet displays, and what the account contract rebuilds. */
export interface SignedMessage {
  /**
   * The salt of the signing domain: the id of the network the signature is
   * good on. It is all the wallet prompt says about the network, and it says
   * it as 32 bytes of hex.
   */
  salt: Hex;
  /** Strkey of the account contract. */
  account: string;
  /** Every call being authorised, root first. */
  calls: Call[];
  /** The 32-byte Soroban authorisation payload. */
  payload: Hex;
}

export type PanelLabel = "salt" | "account" | "contract" | "fn" | "args" | "payload";

/** One line of a panel. The two panels share ids, so a line can be found on the other side. */
export interface PanelLine {
  id: string;
  label: PanelLabel;
  value: string;
  /** A name for a known contract, "USDC", "Paso hub", or what a salt means: "Stellar mainnet". */
  name?: string;
  /** The Soroban type of an argument of a generic call: the text alone does not say whether `5` is a number or a string. */
  type?: string;
  /** What a reader should be told about this line before signing it, in a few words. */
  warning?: string;
  /** True when the other panel shows something else on this line. */
  differs: boolean;
}

export type Verdict =
  /** Nothing to compare yet. */
  | "none"
  /** The wallet has the message; nothing has been submitted. */
  | "unsigned"
  /** Submitted, waiting for the account contract's answer. */
  | "checking"
  /** The contract rebuilt the same message and accepted the signature. */
  | "match"
  /** The contract rebuilt a different message, or the call itself was refused. Nothing moved. */
  | "refused";

/** Everything the two panels show. */
export interface Panels {
  /** "Your wallet shows": the message as signed. */
  wallet: PanelLine[];
  /** "The contract verifies": the message rebuilt from what was submitted. `null` until something is. */
  contract: PanelLine[] | null;
  verdict: Verdict;
  /** Ids of the lines that are not the same on both sides. */
  differingLines: string[];
}

export const NO_PANELS: Panels = { wallet: [], contract: null, verdict: "none", differingLines: [] };

type PlainLine = Omit<PanelLine, "differs">;

/** The network a domain salt stands for, in words. The hex alone tells a reader nothing. */
export function saltMeaning(salt: Hex): string {
  const network = saltNetwork(salt);
  return network ? `Stellar ${network}` : "not a network this app knows";
}

const CONCERN_WORDS: Record<ArgConcern, string> = {
  control: "contains control characters",
  newline: "contains a line break",
  bidi: "contains characters that change the direction of the text",
  invisible: "contains characters that cannot be seen",
  looks_like_field: "text shaped like another line of the message",
  looks_like_address: "looks like an address, and is text",
  looks_like_hash: "looks like bytes or a hashed value, and is text",
  hashed: "bound by its hash: the value itself cannot be read here",
};

/** What to say about a line, from what was found in it. */
export function concernWords(concerns: readonly ArgConcern[]): string | undefined {
  return concerns.length > 0 ? concerns.map((concern) => CONCERN_WORDS[concern]).join(", and ") : undefined;
}

/** True when anything in the calls wants reading before it is signed. */
export function hasConcerns(calls: readonly DescribedCall[]): boolean {
  return calls.some((call) => call.fnConcerns.length > 0 || call.args.some((arg) => arg.concerns.length > 0));
}

function flatten(
  message: SignedMessage,
  nameOf: (address: string) => string | undefined,
  described?: readonly DescribedCall[],
): PlainLine[] {
  const lines: PlainLine[] = [
    { id: "salt", label: "salt", value: message.salt, name: saltMeaning(message.salt) },
    { id: "account", label: "account", value: message.account },
  ];
  message.calls.forEach((call, index) => {
    const name = nameOf(call.contract);
    lines.push({ id: `call.${index}.contract`, label: "contract", value: call.contract, ...(name ? { name } : {}) });
    const about = described?.[index];
    const fnWarning = about ? concernWords(about.fnConcerns) : undefined;
    lines.push({ id: `call.${index}.fn`, label: "fn", value: call.fn, ...(fnWarning ? { warning: fnWarning } : {}) });
    call.args.forEach((arg, position) => {
      const told = about?.args[position];
      const warning = told ? concernWords(told.concerns) : undefined;
      lines.push({
        id: `call.${index}.args.${position}`,
        label: "args",
        value: arg,
        ...(told ? { type: told.type } : {}),
        ...(warning ? { warning } : {}),
      });
    });
  });
  lines.push({ id: "payload", label: "payload", value: message.payload });
  return lines;
}

/**
 * The lines of one panel, each marked when the other side shows something
 * else there, or has no such line at all.
 */
export function messageLines(
  message: SignedMessage,
  other: SignedMessage | null = null,
  nameOf: (address: string) => string | undefined = () => undefined,
  described?: readonly DescribedCall[],
): PanelLine[] {
  const theirs = new Map((other ? flatten(other, nameOf) : []).map((line) => [line.id, line.value]));
  return flatten(message, nameOf, described).map((line) => ({
    ...line,
    differs: other !== null && theirs.get(line.id) !== line.value,
  }));
}

/** Ids of every line that differs between two messages, in display order. */
export function differingLines(shown: SignedMessage, attempted: SignedMessage): string[] {
  const ids = new Set<string>();
  for (const line of messageLines(shown, attempted)) if (line.differs) ids.add(line.id);
  for (const line of messageLines(attempted, shown)) if (line.differs) ids.add(line.id);
  return [...ids];
}

/**
 * Both panels for a pair of messages. `attempted` is `null` while nothing has
 * been submitted. `described` says what the shown calls' arguments are, for a
 * generic call: their types and what to watch for go on the wallet's side.
 */
export function comparePanels(
  shown: SignedMessage,
  attempted: SignedMessage | null,
  verdict: Verdict,
  nameOf?: (address: string) => string | undefined,
  described?: readonly DescribedCall[],
): Panels {
  return {
    wallet: messageLines(shown, attempted, nameOf, described),
    contract: attempted ? messageLines(attempted, shown, nameOf) : null,
    verdict,
    differingLines: attempted ? differingLines(shown, attempted) : [],
  };
}
