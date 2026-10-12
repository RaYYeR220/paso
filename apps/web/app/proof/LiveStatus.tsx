"use client";

import { ExternalLink, Skeleton } from "@/components/app";
import { NETWORK, stellarAddress, useHealth } from "@/lib/client";

/** What the running server says about itself, read from `/api/health`. */
export function LiveStatus() {
  const health = useHealth();
  const { report } = health;
  const waiting = report === null && health.error === null;
  const hub = report?.hub || NETWORK.stellar.hub;

  return (
    <div className="live" aria-live="polite">
      <h2>Live relayer status</h2>
      {health.error && report === null ? (
        <p>The server did not answer: {health.error}</p>
      ) : (
        <dl className="facts">
          <div>
            <dt>Network</dt>
            <dd>{waiting ? <Skeleton width="5em" /> : report?.network}</dd>
          </div>
          <div>
            <dt>Hub</dt>
            <dd className="hash">
              {waiting ? <Skeleton width="100%" /> : <ExternalLink href={stellarAddress(hub)}>{hub}</ExternalLink>}
            </dd>
          </div>
          <div>
            <dt>Relayer</dt>
            <dd className="hash">
              {report ? (
                <ExternalLink href={stellarAddress(report.relayer.address)}>{report.relayer.address}</ExternalLink>
              ) : (
                <Skeleton width="100%" />
              )}
            </dd>
          </div>
          <div>
            <dt>Ledger</dt>
            <dd>{report ? (report.latestLedger ?? "unknown") : <Skeleton width="6em" />}</dd>
          </div>
        </dl>
      )}
      <p className="live-foot">The relayer pays Stellar fees and nothing else. It cannot move funds.</p>
    </div>
  );
}
