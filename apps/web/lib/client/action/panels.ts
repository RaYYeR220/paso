import type { Call } from "@paso/sdk";
import type { Hex } from "viem";

/** The message a signature is about: what the wallet displays, and what the account contract rebuilds. */
export interface SignedMessage {
  /** Strkey of the account contract. */
  account: string;
  /** Every call being authorised, root first. */
  calls: Call[];
  /** The 32-byte Soroban authorisation payload. */
  payload: Hex;
}

export type PanelLabel = "account" | "contract" | "fn" | "args" | "payload";

/** One line of a panel. The two panels share ids, so a line can be found on the other side. */
export interface PanelLine {
  id: string;
  label: PanelLabel;
  value: string;
  /** A name for a known contract: "USDC", "Paso hub". */
  name?: string;
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

function flatten(message: SignedMessage, nameOf: (address: string) => string | undefined): PlainLine[] {
  const lines: PlainLine[] = [{ id: "account", label: "account", value: message.account }];
  message.calls.forEach((call, index) => {
    const name = nameOf(call.contract);
    lines.push({ id: `call.${index}.contract`, label: "contract", value: call.contract, ...(name ? { name } : {}) });
    lines.push({ id: `call.${index}.fn`, label: "fn", value: call.fn });
    call.args.forEach((arg, position) => {
      lines.push({ id: `call.${index}.args.${position}`, label: "args", value: arg });
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
): PanelLine[] {
  const theirs = new Map((other ? flatten(other, nameOf) : []).map((line) => [line.id, line.value]));
  return flatten(message, nameOf).map((line) => ({
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

/** Both panels for a pair of messages. `attempted` is `null` while nothing has been submitted. */
export function comparePanels(
  shown: SignedMessage,
  attempted: SignedMessage | null,
  verdict: Verdict,
  nameOf?: (address: string) => string | undefined,
): Panels {
  return {
    wallet: messageLines(shown, attempted, nameOf),
    contract: attempted ? messageLines(attempted, shown, nameOf) : null,
    verdict,
    differingLines: attempted ? differingLines(shown, attempted) : [],
  };
}
