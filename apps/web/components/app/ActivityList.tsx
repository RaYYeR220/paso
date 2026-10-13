import { ExternalLink, Skeleton } from "./primitives";

export interface ActivityItem {
  id: string;
  /** Money in, money out, or a call that was turned down. */
  kind: "received" | "sent" | "refused";
  /** True while the entry is still under way. */
  pending?: boolean;
  /** "Received 10.00 USDC from Arbitrum". */
  text: string;
  /** "2 min ago". */
  time?: string;
  /** ISO timestamp for the `time` element. */
  dateTime?: string;
  /** Each named after its chain: "Base", "Arc", "Stellar". */
  links: readonly { label: string; href: string }[];
}

export interface ActivityListProps {
  items: readonly ActivityItem[];
  loading?: boolean;
  /** Said when the network's own record does not reach far enough back. */
  footnote?: string;
}

export function ActivityList({ items, loading = false, footnote }: ActivityListProps) {
  return (
    <section className="activity" aria-labelledby="activity-h">
      <h2 id="activity-h">Activity</h2>
      {loading && items.length === 0 ? (
        <ul aria-busy="true">
          {[0, 1].map((row) => (
            <li key={row} className="entry">
              <i data-kind="received" />
              <Skeleton width={row ? "46%" : "58%"} />
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        <p className="activity-empty">
          Nothing yet. USDC arriving from another chain, sends and refused calls are listed here as they happen.
        </p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id} className="entry" data-pending={item.pending || undefined}>
              <i data-kind={item.kind} aria-hidden="true" />
              <span className="entry-text">{item.text}</span>
              {item.time ? <time dateTime={item.dateTime}>{item.time}</time> : null}
              <span className="entry-links">
                {item.links.map((link) => (
                  <ExternalLink key={link.label} href={link.href}>
                    {link.label}
                  </ExternalLink>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {footnote ? <p className="activity-foot">{footnote}</p> : null}
    </section>
  );
}
