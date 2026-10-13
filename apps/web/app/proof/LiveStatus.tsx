"use client";

import { formatAmount, type NetworkName } from "@paso/sdk";
import { ExternalLink, Skeleton } from "@/components/app";
import { SCRIPTS_URL } from "@/components/app/site";
import { networkConfig, networkLabel, stellarAddress, useHealth, type NetworkHealth } from "@/lib/client";

const xlm = (stroops: string): string => `${formatAmount(BigInt(stroops), 7)} XLM`;

function Relayer({ network, report }: { network: NetworkName; report: NetworkHealth | null }) {
  const label = networkLabel(network);
  if (report && !report.enabled) {
    return (
      <div className="live-net" data-network={network}>
        <h3>{label}</h3>
        <p>
          The hosted relayer is not serving {network} right now. Everything it does can be done with{" "}
          <ExternalLink href={SCRIPTS_URL}>the project&rsquo;s scripts</ExternalLink>.
        </p>
      </div>
    );
  }
  const hub = report?.hub || networkConfig(network).stellar.hub;
  const fees = report?.fees;
  return (
    <div className="live-net" data-network={network}>
      <h3>{label}</h3>
      <dl className="facts">
        <div>
          <dt>Hub</dt>
          <dd className="hash">
            <ExternalLink href={stellarAddress(hub, network)}>{hub}</ExternalLink>
          </dd>
        </div>
        <div>
          <dt>Relayer</dt>
          <dd className="hash">
            {report ? (
              <ExternalLink href={stellarAddress(report.relayer.address, network)}>{report.relayer.address}</ExternalLink>
            ) : (
              <Skeleton width="100%" />
            )}
          </dd>
        </div>
        <div>
          <dt>Holds</dt>
          <dd>{report ? (report.relayer.xlm === null ? "unknown" : `${report.relayer.xlm} XLM`) : <Skeleton width="6em" />}</dd>
        </div>
        <div>
          <dt>Today</dt>
          <dd>
            {fees ? (
              `${xlm(fees.remainingToday)} left of ${xlm(fees.maxDailyFees)} in fees${report?.paysFees ? "" : ". Not paying right now"}`
            ) : (
              <Skeleton width="12em" />
            )}
          </dd>
        </div>
        <div>
          <dt>Caps</dt>
          <dd>
            {fees && report ? (
              `${xlm(fees.maxResourceFee)} a transaction, keeps ${xlm(fees.minBalance)}. Per caller in an hour: ` +
              `${report.limits.relay.perCallerPerHour} calls, ${report.limits.deploy.perCallerPerHour} deployments, ${report.limits.deliver.perCallerPerHour} deliveries`
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
    </div>
  );
}

/** What the running server says about itself, read from `/api/health`: each network on its own. */
export function LiveStatus() {
  const health = useHealth();
  const failed = health.error !== null && health.report === null;

  return (
    <div className="live" aria-live="polite">
      <h2>Live relayer status</h2>
      {failed ? (
        <p>The server did not answer: {health.error}</p>
      ) : (
        <>
          <Relayer network="mainnet" report={health.of("mainnet")} />
          <Relayer network="testnet" report={health.of("testnet")} />
        </>
      )}
      <p className="live-foot">
        A relayer pays Stellar fees and nothing else. It cannot move funds. The day&rsquo;s figure is what this server
        instance has counted.
      </p>
    </div>
  );
}
