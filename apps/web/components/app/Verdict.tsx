import type { ReactNode } from "react";
import { BorderPost } from "./art/BorderPost";
import { ExternalLink } from "./primitives";

export type VerdictState =
  /** No call has been prepared. */
  | "idle"
  /** The message is on the sheet, waiting for the owner to sign. */
  | "review"
  /** The wallet is open. */
  | "signing"
  /** Signed and submitted; the account contract has not answered yet. */
  | "relaying"
  | "match"
  | "refused"
  /** The signature ran out before it was used. */
  | "expired"
  /** The call never reached a verdict: the wallet or the relayer failed. */
  | "failed";

export interface VerdictProps {
  state: VerdictState;
  /** The address that signed, shortened: "0x7880…767C". */
  signer?: string;
  /** The transaction on the Stellar explorer, once there is one. */
  txHref?: string;
  /** The sentence for `refused` and `failed`. */
  reason?: string;
  /** Seconds since the call was submitted. */
  elapsed?: string;
  /** True when the demonstration will alter the amount after signing. */
  tamper?: boolean;
  /** True when the owner just said no in the wallet: the review is still open. */
  declined?: boolean;
  /** True while a relayer that was unavailable is being asked a second time. */
  retrying?: boolean;
  /**
   * A refusal recorded on chain, to look at. A relayer turns a mismatched
   * call down before sending anything, so a refusal here has no transaction
   * of its own.
   */
  exampleHref?: string;
  onSign?: () => void;
  /** Back from the review to the form. */
  onBack?: () => void;
  /** Prepares the same call again. */
  onSignAgain?: () => void;
  /** Clears a finished call. */
  onReset?: () => void;
}

const WORDS: Record<VerdictState, string> = {
  idle: "Checkpoint",
  review: "Review",
  signing: "Signing",
  relaying: "Checking",
  match: "Match",
  refused: "Refused",
  expired: "Expired",
  failed: "Not sent",
};

const REFUSED = "BadSignature (#2): the transaction does not match what was signed. Nothing moved.";

function Action({ quiet = false, onClick, children }: { quiet?: boolean; onClick?: () => void; children: ReactNode }) {
  if (!onClick) return null;
  return (
    <button type="button" className={quiet ? "linkbtn" : "btn btn-slab"} onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * The verdict again, as one line under the top bar. Only a narrow screen shows
 * it: there the checkpoint is a long way down the page.
 */
export function VerdictStrip({ state, signer, href }: { state: VerdictState; signer?: string; href: string }) {
  if (state !== "match" && state !== "refused") return null;
  return (
    <a className="strip" data-state={state} href={href}>
      {state === "match" ? `Match — signed by ${signer ?? "the account's key"}` : "Refused — this is not what was signed."}
    </a>
  );
}

/** What the account contract said about the signature, with the boom to match. */
export function Verdict({
  state,
  signer,
  txHref,
  reason,
  elapsed,
  tamper = false,
  declined = false,
  retrying = false,
  exampleHref,
  onSign,
  onBack,
  onSignAgain,
  onReset,
}: VerdictProps) {
  let text: ReactNode;
  let actions: ReactNode = null;

  switch (state) {
    case "idle":
      text = "Nothing to check yet. Review a send, and the message your wallet will show appears above.";
      break;
    case "review":
      text = declined
        ? "Declined in the wallet. Nothing was signed."
        : tamper
          ? "Demonstration: a different amount is submitted after you sign. The contract should refuse it."
          : "Your wallet will ask you to sign exactly these lines.";
      actions = (
        <>
          <Action onClick={onSign}>Sign in wallet</Action>
          <Action quiet onClick={onBack}>
            Back
          </Action>
        </>
      );
      break;
    case "signing":
      text = "Waiting for your signature. Compare what the wallet displays with the sheet on the left.";
      break;
    case "relaying":
      text = retrying ? (
        <>
          Still sending: the relayer could not reach Stellar and is being asked once more
          {elapsed ? <span className="elapsed">, {elapsed}</span> : null}. Nothing has been judged yet.
        </>
      ) : (
        <>
          Submitted. The account contract is rebuilding the message from the call it received
          {elapsed ? <span className="elapsed">, {elapsed}</span> : null}.
        </>
      );
      break;
    case "match":
      text = (
        <>
          signed by {signer ?? "the account's key"}
          {txHref ? (
            <>
              {" "}
              <ExternalLink href={txHref}>View the transaction</ExternalLink>
            </>
          ) : null}
        </>
      );
      actions = (
        <Action quiet onClick={onReset}>
          New send
        </Action>
      );
      break;
    case "refused":
      text = (
        <>
          {reason ?? REFUSED}
          <span className="verdict-note">
            {txHref ? (
              <ExternalLink href={txHref}>The refused transaction</ExternalLink>
            ) : (
              <>
                Refused before anything was sent.
                {exampleHref ? (
                  <>
                    {" "}
                    <ExternalLink href={exampleHref}>The same refusal on chain</ExternalLink>
                  </>
                ) : null}
              </>
            )}
          </span>
        </>
      );
      actions = (
        <Action quiet onClick={onReset}>
          Start over
        </Action>
      );
      break;
    case "expired":
      text = "The signature ran out before it was used. Nothing moved.";
      actions = (
        <>
          <Action onClick={onSignAgain}>Sign again</Action>
          <Action quiet onClick={onReset}>
            Discard
          </Action>
        </>
      );
      break;
    case "failed":
      text = reason ?? "The call was not sent. Nothing moved.";
      actions = (
        <>
          <Action onClick={onSignAgain}>Try again</Action>
          <Action quiet onClick={onReset}>
            Discard
          </Action>
        </>
      );
      break;
  }

  return (
    <div className="verdict" data-state={state} role="status" aria-live="polite" aria-atomic="true">
      <strong>{WORDS[state]}</strong>
      <div className="verdict-body">
        <p>{text}</p>
        {actions ? <div className="verdict-actions">{actions}</div> : null}
      </div>
      <BorderPost />
    </div>
  );
}
