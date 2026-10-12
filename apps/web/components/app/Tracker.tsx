import { RouteProfile, type StationStatus } from "./art/RouteProfile";
import { ExternalLink } from "./primitives";

export interface TrackerStage {
  id: string;
  /** Circle's own words: "Burned on Base", "Attested by Circle", "Minted on Stellar". */
  label: string;
  status: StationStatus;
  /** What to say under the label: a short hash, "in progress, 8 s". Defaults to the status. */
  detail?: string;
  /** Where the detail leads once the step is on a chain. */
  href?: string;
}

export interface TrackerProps {
  stages: readonly [TrackerStage, TrackerStage, TrackerStage];
  /** How far along the running step is, 0 to 1. */
  progress?: number;
  /** Only the three steps in a row, without the drawing: for a second transfer shown beside the first. */
  compact?: boolean;
}

const STATUS_WORDS: Record<StationStatus, string> = {
  waiting: "waiting",
  active: "in progress",
  done: "done",
  failed: "stopped here",
};

/** The three steps of a transfer from Base, drawn as a route over the pass. */
export function Tracker({ stages, progress, compact = false }: TrackerProps) {
  const summary = stages.map((stage) => `${stage.label}: ${STATUS_WORDS[stage.status]}`).join(". ");

  return (
    <div className="tracker" data-compact={compact || undefined}>
      {compact ? null : (
        <RouteProfile
          stations={[stages[0].status, stages[1].status, stages[2].status]}
          progress={progress}
          label={`Route over the pass. ${summary}.`}
        />
      )}
      <ol className="legs">
        {stages.map((stage) => {
          const detail = stage.detail ?? STATUS_WORDS[stage.status];
          return (
            <li key={stage.id} data-status={stage.status}>
              <b>{stage.label}</b>
              {stage.href ? <ExternalLink href={stage.href}>{detail}</ExternalLink> : <span>{detail}</span>}
            </li>
          );
        })}
      </ol>
      <p className="vh" role="status" aria-live="polite">
        {summary}.
      </p>
    </div>
  );
}
