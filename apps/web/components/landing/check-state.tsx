"use client";

import { createContext, use, useState, type ReactNode } from "react";

import { DEMO_ADDRESS, MATCHED_TX_URL, REFUSED_TX_URL, shorten } from "./demo";

type Outcome = "match" | "refused";

const CheckContext = createContext<{ outcome: Outcome; choose: (outcome: Outcome) => void }>({
  outcome: "match",
  choose: () => {},
});

/** The section that owns the outcome; the boom at the border follows `data-boom`. */
export function CheckFrame({ id, className, children }: { id: string; className: string; children: ReactNode }) {
  const [outcome, choose] = useState<Outcome>("match");
  return (
    <CheckContext value={{ outcome, choose }}>
      <section id={id} className={className} aria-labelledby={`${id}-title`} data-check={outcome} data-boom={outcome === "refused" ? "down" : "up"}>
        {children}
      </section>
    </CheckContext>
  );
}

const CHOICES: readonly { outcome: Outcome; label: string }[] = [
  { outcome: "match", label: "Match" },
  { outcome: "refused", label: "Refused" },
];

export function CheckSwitch() {
  const { outcome, choose } = use(CheckContext);
  return (
    <div className="states" role="group" aria-label="What the contract is asked to run">
      {CHOICES.map((choice) => (
        <button key={choice.outcome} type="button" className="state" aria-pressed={outcome === choice.outcome} onClick={() => choose(choice.outcome)}>
          {choice.label}
        </button>
      ))}
    </div>
  );
}

export function CheckVerdict() {
  const { outcome } = use(CheckContext);
  const refused = outcome === "refused";
  return (
    <>
      <p className="asked">
        <span className="asked-label">about to run</span>
        <span className="asked-value">{refused ? "≠ a different amount" : "= the same call"}</span>
        <span className="stamp" aria-hidden="true">
          {refused ? "Refused" : "Match"}
        </span>
      </p>
      <p className="verdict" role="status">
        {refused ? (
          <>
            <span>
              Refused —{" "}
              <a href={REFUSED_TX_URL} target="_blank" rel="noreferrer">
                this is not what was signed
              </a>
              . Nothing moved.
            </span>
            <span className="answer">The account answered Error(Contract, #2) BadSignature</span>
          </>
        ) : (
          <span>
            Match —{" "}
            <a href={MATCHED_TX_URL} target="_blank" rel="noreferrer">
              signed by {shorten(DEMO_ADDRESS, 6, 4)}
            </a>
          </span>
        )}
      </p>
    </>
  );
}
