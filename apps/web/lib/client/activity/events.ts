import type { NetworkConfig } from "paso-sdk";
import { Address, scValToNative, xdr, type rpc } from "@stellar/stellar-sdk";

/** A USDC movement in or out of an account, read from the token's events. */
export interface ChainTransfer {
  /** The event id: unique, and ordered the way the ledger ordered the events. */
  id: string;
  direction: "in" | "out";
  /** How the USDC moved: a transfer between addresses, a mint to the account, or a burn from it. */
  via: "transfer" | "mint" | "burn";
  /** USDC in 7-decimal units. */
  amount: bigint;
  /** The other address; `null` for a mint or a burn, which have none. */
  counterparty: string | null;
  /** When the ledger closed, in milliseconds. */
  at: number;
  ledger: number;
  txHash: string;
}

export interface ChainActivity {
  transfers: ChainTransfer[];
  /** How far back the network's own record reaches, in milliseconds: events before this cannot be listed. */
  since: number | null;
}

const PAGE_SIZE = 1_000;
const MAX_PAGES = 5;
/** Kept clear of the oldest ledger, which leaves the record while the request is on its way. */
const OLDEST_LEDGER_MARGIN = 16;

const symbol = (name: string): string => xdr.ScVal.scvSymbol(name).toXdr("base64");

/**
 * The topic patterns that catch every USDC event naming the account: as the
 * sender or the receiver of a transfer, as the receiver of a mint (with and
 * without the admin topic older events carry), and as the holder in a burn.
 */
export function accountTopics(account: string): string[][] {
  const self = new Address(account).toScVal().toXdr("base64");
  return [
    [symbol("transfer"), self, "*", "*"],
    [symbol("transfer"), "*", self, "*"],
    [symbol("mint"), "*", self, "*"],
    [symbol("mint"), self, "*"],
    [symbol("burn"), self, "*"],
  ];
}

function addressOf(value: xdr.ScVal | undefined): string | null {
  if (value?.type !== "scvAddress") return null;
  try {
    return Address.fromScVal(value).toString();
  } catch {
    return null;
  }
}

/** The amount of a token event: an i128, or a map carrying one under `amount`. */
function amountOf(value: xdr.ScVal): bigint | null {
  const native: unknown = scValToNative(value);
  if (typeof native === "bigint") return native;
  if (typeof native === "object" && native !== null && "amount" in native) {
    const { amount } = native as { amount: unknown };
    return typeof amount === "bigint" ? amount : null;
  }
  return null;
}

interface RawEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

/** Reads one token event as a movement of the account's USDC, or `null` when it is not one. */
export function parseTransfer(event: RawEvent, account: string): ChainTransfer | null {
  const [kind, second, third] = event.topic;
  if (kind?.type !== "scvSymbol") return null;
  const name = kind.sym.toString();
  const amount = amountOf(event.value);
  if (amount === null) return null;

  const base = {
    id: event.id,
    amount,
    at: Date.parse(event.ledgerClosedAt),
    ledger: event.ledger,
    txHash: event.txHash,
  };

  if (name === "transfer") {
    const from = addressOf(second);
    const to = addressOf(third);
    if (from === account) return { ...base, direction: "out", via: "transfer", counterparty: to };
    if (to === account) return { ...base, direction: "in", via: "transfer", counterparty: from };
    return null;
  }
  if (name === "mint") {
    // `mint, to, asset` today; `mint, admin, to, asset` in older events.
    const to = event.topic.length >= 4 ? addressOf(third) : addressOf(second);
    return to === account ? { ...base, direction: "in", via: "mint", counterparty: null } : null;
  }
  if (name === "burn") {
    return addressOf(second) === account ? { ...base, direction: "out", via: "burn", counterparty: null } : null;
  }
  return null;
}

/**
 * Lists the account's USDC movements the network still remembers, newest
 * first. Stellar RPC keeps events for about seven days; anything older is
 * not an error, it is simply no longer listed.
 */
export async function loadChainActivity(
  account: string,
  network: NetworkConfig,
  server: rpc.Server,
): Promise<ChainActivity> {
  const health = await server.getHealth();
  const startLedger = Math.min(health.oldestLedger + OLDEST_LEDGER_MARGIN, health.latestLedger);
  const filters = [{ type: "contract" as const, contractIds: [network.stellar.usdc], topics: accountTopics(account) }];

  const transfers = new Map<string, ChainTransfer>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await server.getEvents(
      cursor ? { filters, cursor, limit: PAGE_SIZE } : { filters, startLedger, limit: PAGE_SIZE },
    );
    for (const event of response.events) {
      const transfer = parseTransfer(event, account);
      if (transfer) transfers.set(transfer.id, transfer);
    }
    if (response.events.length < PAGE_SIZE || !response.cursor || response.cursor === cursor) break;
    cursor = response.cursor;
  }

  // Reported by the RPC next to the oldest ledger; older client typings do not list it.
  const oldestCloseTime = Number((health as { oldestLedgerCloseTime?: string | number }).oldestLedgerCloseTime);
  return {
    transfers: [...transfers.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)),
    since: Number.isFinite(oldestCloseTime) && oldestCloseTime > 0 ? oldestCloseTime * 1000 : null,
  };
}
