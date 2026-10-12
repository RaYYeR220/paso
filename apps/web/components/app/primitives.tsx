import type { AnchorHTMLAttributes, CSSProperties, ReactNode } from "react";

/** A link that leaves the app: a block explorer, a source file. */
export function ExternalLink({ children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className="out" target="_blank" rel="noreferrer" {...rest}>
      {children}
      <svg className="out-mark" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        <path d="M2 8L8 2M3.4 2H8V6.6" fill="none" stroke="currentColor" strokeWidth={1.3} />
      </svg>
      <span className="vh"> (opens in a new tab)</span>
    </a>
  );
}

/** A placeholder bar for a value that is still loading. */
export function Skeleton({ width, height }: { width: CSSProperties["width"]; height?: CSSProperties["height"] }) {
  return <span className="skel" style={{ width, height }} aria-hidden="true" />;
}

export interface NoticeProps {
  /** `problem` for something that failed; `note` for a decision or a plain fact. */
  tone?: "problem" | "note";
  children: ReactNode;
  /** The original explanation, behind a disclosure. */
  detail?: string;
  /** Label and handler of the one thing to do next. */
  actionLabel?: string;
  onAction?: () => void;
  /** Seconds until the action can work again. */
  retryAfterSeconds?: number;
}

/** One sentence about what happened and, when there is one, the way forward. */
export function Notice({ tone = "problem", children, detail, actionLabel, onAction, retryAfterSeconds }: NoticeProps) {
  const waiting = retryAfterSeconds !== undefined && retryAfterSeconds > 0;
  return (
    <div className="notice" data-tone={tone} role={tone === "problem" ? "alert" : "status"}>
      <span className="notice-mark" aria-hidden="true" />
      <p>
        {children}
        {waiting ? ` Try again in ${retryAfterSeconds} s.` : null}
      </p>
      {actionLabel && onAction ? (
        <button type="button" className="linkbtn" onClick={onAction} disabled={waiting}>
          {actionLabel}
        </button>
      ) : null}
      {detail ? (
        <details>
          <summary>Details</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
    </div>
  );
}
