import type { ReactNode } from "react";
import { Skeleton } from "./primitives";

export type MessageLabel = "salt" | "account" | "contract" | "fn" | "args" | "payload";

/** One line of the signed message. Both sides use the same ids, so lines pair up. */
export interface MessageLine {
  id: string;
  label: MessageLabel;
  value: string;
  /** A name for a known contract, "USDC", or what the salt means: "Stellar mainnet". */
  name?: string;
  /** The Soroban type of an argument, where the text alone does not say it: "string", "i128". */
  type?: string;
  /** What a reader should be told about this line before signing, in a few words. */
  warning?: string;
  /** True when the other side shows something else on this line. */
  differs: boolean;
}

export interface MessagePanelsProps {
  /** "Your wallet shows": the message as signed. Empty before a call is prepared. */
  wallet: readonly MessageLine[];
  /** "The contract verifies": the message rebuilt from what was submitted; `null` until something is. */
  contract: readonly MessageLine[] | null;
  /** True while the call is being prepared. */
  loading?: boolean;
}

interface Row {
  id: string;
  label: MessageLabel;
  showLabel: boolean;
  shown?: MessageLine;
  rebuilt?: MessageLine;
  relation: "open" | "same" | "differs";
}

const OUTLINE: readonly MessageLabel[] = ["salt", "account", "contract", "fn", "args", "payload"];

function pair(wallet: readonly MessageLine[], contract: readonly MessageLine[] | null): Row[] {
  const rebuilt = new Map((contract ?? []).map((line) => [line.id, line]));
  const shownIds = new Set(wallet.map((line) => line.id));
  const ordered = [...wallet, ...(contract ?? []).filter((line) => !shownIds.has(line.id))];
  return ordered.map((line, index) => {
    const shown = shownIds.has(line.id) ? line : undefined;
    const other = rebuilt.get(line.id);
    const differs = contract !== null && (!shown || !other || shown.differs || other.differs);
    return {
      id: line.id,
      label: line.label,
      showLabel: ordered[index - 1]?.label !== line.label || line.label !== "args",
      shown,
      rebuilt: other,
      relation: contract === null ? "open" : differs ? "differs" : "same",
    };
  });
}

const LONG_VALUE = 40;

/**
 * An address or a hash is never shortened here: it is what is being approved.
 * It wraps instead, and breaks in the middle when it can so both halves read
 * as halves.
 */
function halved(value: string): ReactNode {
  const prefix = value.startsWith("0x") ? 2 : 0;
  const middle = prefix + Math.ceil((value.length - prefix) / 2);
  return (
    <>
      {value.slice(0, middle)}
      <wbr />
      {value.slice(middle)}
    </>
  );
}

/**
 * The value with the part that is not on the other side inked in, when the
 * change is small enough to point at: one digit added to an amount, say.
 */
function inked(value: string, other: string | undefined): ReactNode {
  if (value.length >= LONG_VALUE) return halved(value);
  if (other === undefined || other === value) return value;
  let start = 0;
  while (start < value.length && start < other.length && value[start] === other[start]) start += 1;
  let end = 0;
  while (
    end < value.length - start &&
    end < other.length - start &&
    value[value.length - 1 - end] === other[other.length - 1 - end]
  ) {
    end += 1;
  }
  const changed = value.slice(start, value.length - end);
  if (changed.length === 0 || changed.length > 6) return value;
  return (
    <>
      {value.slice(0, start)}
      <mark>{changed}</mark>
      {value.slice(value.length - end)}
    </>
  );
}

const SIGN: Record<Row["relation"], { glyph: string; words: string }> = {
  open: { glyph: "", words: "not checked yet" },
  same: { glyph: "=", words: "same on both sides" },
  differs: { glyph: "≠", words: "differs" },
};

function Sheet({
  side,
  title,
  rows,
  span,
  cell,
}: {
  side: "wallet" | "contract";
  title: string;
  rows: readonly Row[];
  span: number;
  cell: (row: Row) => ReactNode;
}) {
  const own = (row: Row) => (side === "wallet" ? row.shown : row.rebuilt);
  return (
    <article className="sheet" data-side={side} style={{ gridRow: `span ${span}` }}>
      <h2 className="sheet-head">{title}</h2>
      <dl className="msg" style={{ gridRow: `span ${rows.length}` }}>
        {rows.map((row) => (
          <div
            key={row.id}
            className="line"
            data-relation={row.relation}
            data-role={row.relation === "differs" ? (row.label === "payload" ? "effect" : "cause") : undefined}
          >
            <dt>
              {row.showLabel ? row.label : <span className="vh">{row.label}</span>}
              {own(row)?.type ? <span className="argtype">{own(row)?.type}</span> : null}
              {own(row)?.name ? <b className="tok">{own(row)?.name}</b> : null}
              {side === "contract" ? (
                <span className="sign" data-relation={row.relation}>
                  <span aria-hidden="true">{SIGN[row.relation].glyph}</span>
                  <span className="vh">{SIGN[row.relation].words}</span>
                </span>
              ) : null}
            </dt>
            <dd>{cell(row)}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

/**
 * The checkpoint: the message the wallet displays on one sheet, the message
 * the account contract rebuilds on the other, and a lane for every line.
 */
export function MessagePanels({ wallet, contract, loading = false }: MessagePanelsProps) {
  const outline = wallet.length === 0;
  const rows: Row[] = outline
    ? OUTLINE.map((label) => ({ id: label, label, showLabel: true, relation: "open" }))
    : pair(wallet, contract);
  const span = rows.length + 1;

  const value = (line: MessageLine | undefined, other: MessageLine | undefined): ReactNode =>
    line ? (
      <>
        <span className="val">{inked(line.value, other?.value)}</span>
        {line.warning ? <span className="argwarn">{line.warning}</span> : null}
      </>
    ) : (
      <span className="absent">not in this message</span>
    );

  return (
    <div className="sheets" data-outline={outline || undefined}>
      <Sheet
        side="wallet"
        title="Your wallet shows"
        rows={rows}
        span={span}
        cell={(row) =>
          outline ? (
            loading ? <Skeleton width={row.label === "fn" ? "5em" : "100%"} /> : <span className="blank" />
          ) : (
            value(row.shown, row.rebuilt)
          )
        }
      />
      <div className="lanes" aria-hidden="true" style={{ gridRow: `span ${span}` }}>
        <span />
        {rows.map((row) => (
          <div key={row.id} className="lane" data-relation={row.relation}>
            <b>{SIGN[row.relation].glyph}</b>
          </div>
        ))}
      </div>
      <Sheet
        side="contract"
        title="The contract verifies"
        rows={rows}
        span={span}
        cell={(row) => (outline || contract === null ? <span className="blank" /> : value(row.rebuilt, row.shown))}
      />
    </div>
  );
}
