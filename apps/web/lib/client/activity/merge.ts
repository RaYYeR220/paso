import { DEFAULT_EVM_CHAIN, type NetworkConfig } from "paso-sdk";
import { chainOf } from "../chains";
import { evmTx, stellarAddress, stellarTx } from "../explorer";
import { formatUsdc, shortAddress } from "../format";
import type { ChainTransfer } from "./events";
import type { LogEntry } from "./log";

export type ActivityKind = "received" | "sent" | "exit" | "call" | "refused";

export type ActivityStatus =
  /** Under way: a burn on an EVM chain that has not been minted on Stellar yet. */
  | "pending"
  | "confirmed"
  /** Turned down by the account contract or the relayer. Nothing moved. */
  | "refused"
  | "failed";

/** One line of the activity list. */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  /** The line as a sentence: "Received 10.00 USDC from Arbitrum". */
  title: string;
  /** USDC in 7-decimal units, or `null` when the line is not about an amount. */
  amount: bigint | null;
  /** The other side's address, or `null` (a mint, a burn, a chain as a whole). */
  counterparty: string | null;
  /** True when the other side is an EVM chain: the USDC crossed over CCTP. */
  crossChain: boolean;
  /** Milliseconds since the epoch. */
  time: number;
  links: {
    /** The transaction on Stellar; for a line without one, the account itself. */
    stellar: string | null;
    /** The burn on the EVM chain, where one belongs to this line, under the chain's name. */
    evm: { label: string; href: string } | null;
  };
  /** Where the line comes from: Stellar's events, this browser's own record, or both. */
  source: "chain" | "session" | "both";
}

export interface MergeContext {
  account: string;
  network: NetworkConfig;
}

/** How much later than its record a matching mint may appear on Stellar. */
const MATCH_WINDOW_MS = 30 * 60_000;
/** Clocks differ: a mint may seem to precede the moment this browser noted the burn. */
const CLOCK_SLACK_MS = 2 * 60_000;

const hashKey = (hash: string): string => hash.replace(/^0x/i, "").toLowerCase();

function usdc(amount: bigint | null): string {
  return amount === null ? "USDC" : `${formatUsdc(amount)} USDC`;
}

/** The name of the chain an entry is about. An entry written before there was a choice is about Base. */
function chainLabel(entry: LogEntry, network: NetworkConfig): string {
  return chainOf(network, entry.chain ?? DEFAULT_EVM_CHAIN).shortLabel;
}

/** The entry's transaction on its EVM chain, named after the chain. */
function evmLink(entry: LogEntry | undefined, network: NetworkConfig): ActivityItem["links"]["evm"] {
  if (!entry?.evmTxHash) return null;
  const chain = entry.chain ?? DEFAULT_EVM_CHAIN;
  return { label: chainOf(network, chain).shortLabel, href: evmTx(entry.evmTxHash, network, chain) };
}

function fromChain(transfer: ChainTransfer, context: MergeContext, entry?: LogEntry): ActivityItem {
  const { network } = context;
  const { hub, forwarder, tokenMessenger } = network.stellar;
  const { counterparty } = transfer;
  const incoming = transfer.direction === "in";
  const crossChain = incoming
    ? transfer.via === "mint" || counterparty === forwarder || entry?.kind === "receive"
    : transfer.via === "burn" || counterparty === hub || counterparty === tokenMessenger || entry?.kind === "exit";

  // Stellar's events do not say which chain USDC came from or went to; this browser's record does, when it has one.
  const known = entry && (entry.kind === "receive" || entry.kind === "exit") ? chainLabel(entry, network) : null;
  let title: string;
  if (incoming) {
    title = crossChain
      ? `Received ${usdc(transfer.amount)} from ${known ?? "another chain"}`
      : `Received ${usdc(transfer.amount)}${counterparty ? ` from ${shortAddress(counterparty)}` : ""}`;
  } else if (crossChain) {
    title = known
      ? `Sent ${usdc(transfer.amount)} back to ${known}${entry?.counterparty ? ` · ${shortAddress(entry.counterparty)}` : ""}`
      : `Sent ${usdc(transfer.amount)} to another chain`;
  } else {
    title = `Sent ${usdc(transfer.amount)}${counterparty ? ` to ${shortAddress(counterparty)}` : ""}`;
  }

  return {
    id: transfer.id,
    kind: incoming ? "received" : crossChain ? "exit" : "sent",
    status: "confirmed",
    title,
    amount: transfer.amount,
    counterparty: crossChain ? (entry?.kind === "exit" ? entry.counterparty : null) : counterparty,
    crossChain,
    time: transfer.at,
    links: {
      stellar: stellarTx(transfer.txHash, network),
      evm: evmLink(entry, network),
    },
    source: entry ? "both" : "chain",
  };
}

function fromLog(entry: LogEntry, context: MergeContext): ActivityItem {
  const { network, account } = context;
  const amount = entry.amount !== null && /^\d+$/.test(entry.amount) ? BigInt(entry.amount) : null;
  const to = entry.counterparty ? shortAddress(entry.counterparty) : null;
  const chain = chainLabel(entry, network);

  let kind: ActivityKind;
  let status: ActivityStatus;
  let title: string;
  switch (entry.kind) {
    case "receive":
      kind = "received";
      status = entry.status === "done" ? "confirmed" : entry.status === "failed" ? "failed" : "pending";
      title =
        status === "confirmed"
          ? `Received ${usdc(amount)} from ${chain}`
          : status === "failed"
            ? `${usdc(amount)} from ${chain} did not arrive`
            : `Receiving ${usdc(amount)} from ${chain}`;
      break;
    case "send":
      kind = "sent";
      status = "confirmed";
      title = `Sent ${usdc(amount)}${to ? ` to ${to}` : ""}`;
      break;
    case "exit":
      kind = "exit";
      status = "confirmed";
      title = `Sent ${usdc(amount)} back to ${chain}${to ? ` · ${to}` : ""}`;
      break;
    case "call":
      kind = "call";
      status = "confirmed";
      title = `Called ${entry.note ?? "a contract"}${to ? ` on ${to}` : ""}`;
      break;
    case "refused":
      kind = "refused";
      status = "refused";
      title = `Refused: ${entry.note ?? "the call was turned down"}`;
      break;
  }

  return {
    id: entry.id,
    kind,
    status,
    title,
    amount,
    counterparty: entry.kind === "receive" ? null : entry.counterparty,
    crossChain: entry.kind === "receive" || entry.kind === "exit",
    time: entry.at,
    links: {
      stellar: entry.stellarTxHash ? stellarTx(entry.stellarTxHash, network) : stellarAddress(account, network),
      evm: evmLink(entry, network),
    },
    source: "session",
  };
}

/**
 * One list out of two records: the USDC movements Stellar reports for the
 * account, and what this browser did itself. A movement known to both appears
 * once, with the chain and the link only the browser knows. Newest first.
 */
export function mergeActivity(chain: ChainTransfer[], log: LogEntry[], context: MergeContext): ActivityItem[] {
  const { forwarder } = context.network.stellar;
  const byHash = new Map<string, LogEntry>();
  for (const entry of log) {
    if (entry.stellarTxHash) byHash.set(hashKey(entry.stellarTxHash), entry);
  }

  const used = new Set<string>();
  const matched = new Map<string, LogEntry>();

  for (const transfer of chain) {
    const entry = byHash.get(hashKey(transfer.txHash));
    if (entry && !used.has(entry.id)) {
      used.add(entry.id);
      matched.set(transfer.id, entry);
    }
  }

  // A transfer delivered by someone else comes without a Stellar hash: pair it with the mint that followed it.
  const arrivals = chain
    .filter((transfer) => transfer.direction === "in" && (transfer.via === "mint" || transfer.counterparty === forwarder))
    .sort((a, b) => a.at - b.at);
  const unpaired = log
    .filter((entry) => entry.kind === "receive" && entry.status === "done" && !entry.stellarTxHash && !used.has(entry.id))
    .sort((a, b) => a.at - b.at);
  for (const entry of unpaired) {
    const arrival = arrivals.find(
      (transfer) =>
        !matched.has(transfer.id) &&
        transfer.at >= entry.at - CLOCK_SLACK_MS &&
        transfer.at <= entry.at + MATCH_WINDOW_MS,
    );
    if (arrival) {
      used.add(entry.id);
      matched.set(arrival.id, entry);
    }
  }

  const items = [
    ...chain.map((transfer) => fromChain(transfer, context, matched.get(transfer.id))),
    ...log.filter((entry) => !used.has(entry.id)).map((entry) => fromLog(entry, context)),
  ];
  return items.sort((a, b) => b.time - a.time);
}
