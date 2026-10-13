import type { ActivityItem as ActivityRow, TrackerStage as StageView, VerdictState } from "@/components/app";
import {
  formatElapsed,
  relativeTime,
  shortHash,
  type ActionFlow,
  type ActivityItem,
  type DeclineReason,
  type Exit,
  type Funding,
  type RequestStep,
} from "@/lib/client";

type Stages = [StageView, StageView, StageView];

/** What is being waited for while the burn on Base is prepared. */
const REQUEST_WORDS: Record<RequestStep, { wallet: string; demo: string }> = {
  starting: { wallet: "opening the wallet", demo: "asking the faucet" },
  approving: { wallet: "approve USDC in the wallet", demo: "asking the faucet" },
  approved: { wallet: "approval confirming", demo: "asking the faucet" },
  burning: { wallet: "confirm in the wallet", demo: "asking the faucet" },
  confirming: { wallet: "confirming on Base", demo: "confirming on Base" },
};

function running(elapsedSeconds: number | null): string {
  return elapsedSeconds === null ? "in progress" : `in progress, ${formatElapsed(elapsedSeconds)}`;
}

/** The inbound tracker: each of the hook's three steps with the words and the link that go under it. */
export function fundingStages(funding: Funding): Stages {
  const { state, links, elapsedSeconds } = funding;
  const burnHash = "transfer" in state && state.transfer ? state.transfer.burnTxHash : undefined;
  const held = state.phase === "attesting" && state.held !== undefined;

  return funding.stages.map((stage): StageView => {
    const view: StageView = { id: stage.id, label: stage.label, status: stage.status };
    if (stage.status === "waiting" || stage.status === "failed") return view;

    switch (stage.id) {
      case "burned":
        if (stage.status === "done" && burnHash && links.base) return { ...view, detail: shortHash(burnHash), href: links.base };
        if (state.phase === "requesting") return { ...view, detail: REQUEST_WORDS[state.step][state.via] };
        return view;
      case "attested":
        if (stage.status === "active") return { ...view, detail: held ? "waiting for a relayer" : running(elapsedSeconds) };
        return view;
      case "minted":
        if (stage.status === "active") return { ...view, detail: "delivering" };
        if (links.stellar) {
          const hash = state.phase === "minted" ? state.stellarTxHash : undefined;
          return { ...view, detail: hash ? shortHash(hash) : "arrived", href: links.stellar };
        }
        return { ...view, detail: "arrived" };
    }
  }) as Stages;
}

/** The outbound tracker: the same three steps, from Stellar back to Base. */
export function exitStages(exit: Exit): Stages {
  const { state, links, elapsedSeconds } = exit;
  return exit.stages.map((stage): StageView => {
    const view: StageView = { id: stage.id, label: stage.label, status: stage.status };
    switch (stage.id) {
      case "burned":
        return state.phase !== "idle" && links.stellar
          ? { ...view, detail: shortHash(state.transfer.stellarTxHash), href: links.stellar }
          : view;
      case "attested":
        if (state.phase === "untracked") return { ...view, detail: "about 20 seconds" };
        return stage.status === "active" ? { ...view, detail: running(elapsedSeconds) } : view;
      case "minted":
        if (state.phase === "attested") return { ...view, detail: "your wallet's turn" };
        if (state.phase === "minting") {
          return state.baseTxHash && links.base
            ? { ...view, detail: "confirming", href: links.base }
            : { ...view, detail: "confirm in the wallet" };
        }
        if (stage.status !== "done") return view;
        return links.base && state.phase === "minted" && state.baseTxHash
          ? { ...view, detail: shortHash(state.baseTxHash), href: links.base }
          : { ...view, detail: "arrived" };
    }
  }) as Stages;
}

/** How far the traveller has come towards the next station: quick at first, never quite there. */
export function travelProgress(elapsedSeconds: number | null): number {
  return elapsedSeconds === null ? 0.3 : 1 - Math.exp(-elapsedSeconds / 12);
}

/** Which face the verdict slab shows for a state of the outbound flow. */
export function verdictOf(action: ActionFlow): VerdictState {
  const { state } = action;
  switch (state.phase) {
    case "idle":
    case "preparing":
      return "idle";
    case "review":
      return "review";
    case "signing":
      return "signing";
    case "relaying":
      return "relaying";
    case "done":
      return "match";
    case "refused":
      return "refused";
    case "expired":
      return "expired";
    case "failed":
      if (state.stage === "prepare") return "idle";
      return action.unconfirmed ? "unconfirmed" : "failed";
  }
}

/** Why the hosted relayer is not paying for something right now, as the end of a sentence. */
export function declineWords(reason: DeclineReason, network: string): string {
  switch (reason) {
    case "not_serving":
      return `it is not serving ${network} right now`;
    case "daily_budget":
      return "it has spent what it spends on fees in a day";
    case "hourly_limit":
      return "it has paid for all it pays for in an hour";
    case "low_balance":
      return "its fee account is down to what it keeps in reserve";
  }
}

export function activityRows(items: readonly ActivityItem[], now: number | null): ActivityRow[] {
  return items.map((item): ActivityRow => {
    const links: ActivityRow["links"][number][] = [];
    if (item.links.base) links.push({ label: "Base", href: item.links.base });
    if (item.links.stellar) links.push({ label: "Stellar", href: item.links.stellar });
    return {
      id: item.id,
      kind: item.kind === "received" ? "received" : item.kind === "refused" || item.status === "refused" ? "refused" : "sent",
      pending: item.status === "pending",
      text: item.title,
      ...(now === null ? {} : { time: relativeTime(item.time, now), dateTime: new Date(item.time).toISOString() }),
      links,
    };
  });
}
