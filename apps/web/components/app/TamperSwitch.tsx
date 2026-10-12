"use client";

import { useId } from "react";

export interface TamperSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** True once a call is signed: the switch only applies to the next one. */
  disabled?: boolean;
}

/**
 * A demonstration, and labelled as one: after the owner signs, a different
 * amount is submitted so the refusal can be watched.
 */
export function TamperSwitch({ checked, onChange, disabled = false }: TamperSwitchProps) {
  const id = useId();
  return (
    <div className="tamper">
      <p id={`${id}-about`}>Submits a different amount than you signed, to show the refusal.</p>
      <label>
        <span className="demo-tag">Demo</span>
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={`${id}-about`}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switch-track" aria-hidden="true" />
        Change the amount after signing
      </label>
    </div>
  );
}
