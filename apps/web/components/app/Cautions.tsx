"use client";

import { useId } from "react";

/** What the review asks the owner to read and answer before the wallet is asked. */
export type CautionKind = "recipient_contract" | "recipient_unknown" | "recipient_unproven" | "arguments";

/** What each caution says, and the words that answer it. The wording is quoted in the documentation: change both together. */
export const CAUTION_COPY: Record<CautionKind, { text: string; answer: string; blocking: boolean }> = {
  recipient_contract: {
    text: "This address is a smart contract. It has no key, so its Stellar account could never move what you send. Nothing was sent.",
    answer: "Send anyway. I understand this USDC can never be moved again.",
    blocking: true,
  },
  recipient_unknown: {
    text: "It could not be checked whether this address is a regular wallet or a smart contract. A smart contract has no key, and its Stellar account could never move what you send.",
    answer: "I know this address is a regular wallet.",
    blocking: false,
  },
  recipient_unproven: {
    text: "This address has not used its Stellar account yet. A smart-contract wallet that is not deployed yet looks the same as a regular wallet and cannot be told apart. Only send to an address you know is a regular wallet.",
    answer: "I know this address is a regular wallet.",
    blocking: false,
  },
  arguments: {
    text: "Some lines of this call are marked. A wallet shows them as plain text, without their type: text can be made to look like an address, a number or another line, and a hashed value cannot be read at all.",
    answer: "I have read the marked lines.",
    blocking: false,
  },
};

export interface CautionsProps {
  cautions: readonly CautionKind[];
  confirmed: readonly CautionKind[];
  onConfirm: (caution: CautionKind, on: boolean) => void;
}

/** The warnings of a review, each with the box that answers it. Signing waits until every one is ticked. */
export function Cautions({ cautions, confirmed, onConfirm }: CautionsProps) {
  const id = useId();
  if (cautions.length === 0) return null;
  return (
    <>
      {cautions.map((caution) => {
        const copy = CAUTION_COPY[caution];
        return (
          <div key={caution} className="caution" data-tone={copy.blocking ? undefined : "note"} role={copy.blocking ? "alert" : "note"}>
            <p id={`${id}-${caution}`}>{copy.text}</p>
            <label>
              <input
                type="checkbox"
                checked={confirmed.includes(caution)}
                aria-describedby={`${id}-${caution}`}
                onChange={(event) => onConfirm(caution, event.target.checked)}
              />
              {copy.answer}
            </label>
          </div>
        );
      })}
    </>
  );
}
