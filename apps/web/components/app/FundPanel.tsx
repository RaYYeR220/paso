"use client";

import { useId, type FormEvent, type ReactNode } from "react";
import { Tracker, type TrackerProps } from "./Tracker";

export interface FundPanelProps {
  /** A wallet burns its own USDC on Base; the demo key asks the testnet faucet. */
  mode: "wallet" | "demo";
  /** Decimal text, as typed. */
  amount: string;
  onAmountChange?: (value: string) => void;
  /** True while a transfer is being requested or followed. */
  busy: boolean;
  /** Stops the form without a transfer running: no signer yet, or a problem to resolve first. */
  disabled?: boolean;
  onSubmit: () => void;
  stages: TrackerProps["stages"];
  progress?: number;
  /** One line under the amount: what the wallet is being asked, a problem, a way to retry. */
  status?: ReactNode;
}

export function FundPanel({ mode, amount, onAmountChange, busy, disabled, onSubmit, stages, progress, status }: FundPanelProps) {
  const id = useId();
  const fixed = mode === "demo";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && !disabled) onSubmit();
  };

  return (
    <section className="fund" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Bring USDC from Base</h2>
      <form className="fund-form" onSubmit={submit} noValidate>
        <label className="field-row" htmlFor={`${id}-amount`}>
          <span>Amount</span>
          <span className="field" data-fixed={fixed || undefined}>
            <input
              id={`${id}-amount`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              readOnly={fixed}
              disabled={busy || disabled}
              aria-describedby={`${id}-status`}
              onChange={(event) => onAmountChange?.(event.target.value)}
            />
            <em>USDC</em>
          </span>
        </label>
        <button className="btn btn-inline" type="submit" disabled={busy || disabled}>
          {busy ? "On its way" : fixed ? "Get test USDC" : "Bring over"}
        </button>
      </form>
      <div className="hint" id={`${id}-status`}>
        {status ?? (fixed ? "The testnet faucet burns this much on Base for you." : "One transaction on Base, about 20 seconds.")}
      </div>
      <Tracker stages={stages} progress={progress} />
    </section>
  );
}
