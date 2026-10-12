"use client";

import { useId, type FormEvent, type ReactNode } from "react";

export type SendDestination = "stellar" | "base";

export interface SendFormProps {
  destination: SendDestination;
  onDestinationChange: (destination: SendDestination) => void;
  /** The recipient as typed: `G…`, `C…`, `0x…` or an ENS name. */
  to: string;
  onToChange: (value: string) => void;
  /** Why the recipient cannot be used. */
  toError?: string;
  /** Decimal text, as typed. */
  amount: string;
  onAmountChange: (value: string) => void;
  amountError?: string;
  /** Why the call as a whole could not be prepared. */
  problem?: string;
  /** True while the call is being prepared. */
  preparing?: boolean;
  /** Stops the form: nothing to send, or a call already under review. */
  disabled?: boolean;
  onSubmit: () => void;
  /** One line under the fields: where the money will land, or a nudge to fund the account first. */
  status?: ReactNode;
  /** Shown under the heading: a transfer already on its way back to Base, say. */
  children?: ReactNode;
}

const DESTINATIONS: readonly { value: SendDestination; label: string }[] = [
  { value: "stellar", label: "another Stellar account" },
  { value: "base", label: "back to Base" },
];

export function SendForm({
  destination,
  onDestinationChange,
  to,
  onToChange,
  toError,
  amount,
  onAmountChange,
  amountError,
  problem: callProblem,
  preparing = false,
  disabled = false,
  onSubmit,
  status,
  children,
}: SendFormProps) {
  const id = useId();
  const locked = preparing || disabled;
  const problem = toError ?? amountError ?? callProblem;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!locked) onSubmit();
  };

  return (
    <section className="send" aria-labelledby={`${id}-h`}>
      <form onSubmit={submit} noValidate>
        <div className="send-head">
          <h2 id={`${id}-h`}>Send</h2>
          <fieldset className="seg" disabled={locked}>
            <legend className="vh">Where it goes</legend>
            {DESTINATIONS.map((option) => (
              <label key={option.value}>
                <input
                  type="radio"
                  name={`${id}-destination`}
                  value={option.value}
                  checked={destination === option.value}
                  onChange={() => onDestinationChange(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
        </div>
        {children}
        <label className="field-row" htmlFor={`${id}-to`}>
          <span>To</span>
          <span className="field" data-invalid={toError ? true : undefined}>
            <input
              id={`${id}-to`}
              type="text"
              value={to}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              disabled={locked}
              placeholder={destination === "base" ? "0x… or ENS name" : "G…, C…, 0x… or ENS name"}
              aria-invalid={toError ? true : undefined}
              aria-describedby={`${id}-status`}
              onChange={(event) => onToChange(event.target.value)}
            />
          </span>
        </label>
        <label className="field-row" htmlFor={`${id}-amount`}>
          <span>Amount</span>
          <span className="field" data-invalid={amountError ? true : undefined}>
            <input
              id={`${id}-amount`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              disabled={locked}
              placeholder="0.00"
              aria-invalid={amountError ? true : undefined}
              aria-describedby={`${id}-status`}
              onChange={(event) => onAmountChange(event.target.value)}
            />
            <em>USDC</em>
          </span>
        </label>
        <div className="hint" id={`${id}-status`} data-tone={problem ? "problem" : undefined} role={problem ? "alert" : undefined}>
          {problem ?? status}
        </div>
        <button className="btn" type="submit" disabled={locked}>
          {preparing ? "Preparing the message" : "Review and sign"}
        </button>
      </form>
    </section>
  );
}
