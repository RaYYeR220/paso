"use client";

import { useId, type ReactNode } from "react";

export interface ChainChoiceOption {
  /** The chain's name in the SDK: "base", "arc". */
  name: string;
  /** What the chip says: the chain's name on every network, "Base", "OP Mainnet". */
  label: string;
  /** False where it cannot be chosen; `note` says why. */
  available?: boolean;
}

export interface ChainChoiceProps {
  /** The question the chips answer, for screen readers: "Bring USDC from", "Send it back to". */
  legend: string;
  options: readonly ChainChoiceOption[];
  value: string;
  onChange: (name: string) => void;
  /** Stops the choice as a whole: a transfer is on its way from the chain chosen. */
  disabled?: boolean;
  /** One line under the chips: what the chain holds, or why some cannot be chosen. */
  note?: ReactNode;
}

/**
 * The chains a route can start or end at, as stops along a road. One is
 * always chosen; arrow keys move between them, as in any group of radio
 * buttons.
 */
export function ChainChoice({ legend, options, value, onChange, disabled = false, note }: ChainChoiceProps) {
  const id = useId();
  return (
    <div className="routes-block">
      <fieldset className="routes" disabled={disabled} aria-describedby={note ? `${id}-note` : undefined}>
        <legend className="vh">{legend}</legend>
        {options.map((option) => (
          <label key={option.name} data-unavailable={option.available === false || undefined}>
            <input
              type="radio"
              name={`${id}-chain`}
              value={option.name}
              checked={value === option.name}
              disabled={option.available === false}
              onChange={() => onChange(option.name)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      {note ? (
        <p className="routes-note" id={`${id}-note`}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
