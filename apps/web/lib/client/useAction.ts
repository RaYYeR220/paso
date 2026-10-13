"use client";

import type { Call, NetworkName } from "@paso/sdk";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SignOptions } from "./action/controller";
import {
  IDLE_ACTION,
  isActionBusy,
  isUnconfirmed,
  panelsOf,
  type ActionRequest,
  type ActionState,
  type Caution,
} from "./action/machine";
import type { Panels } from "./action/panels";
import { contractName, networkConfig } from "./config";
import { stellarAddress, stellarTx } from "./explorer";
import { actionFor, refreshAccount } from "./registry";
import { rememberKeyProven, useSigner } from "./signer";
import { createStore, noSubscription } from "./store";

/** Having the connected owner's account do something on one network: a transfer, a withdrawal to an EVM chain, or any contract call. */
export interface ActionFlow {
  /**
   * The state machine: idle → preparing → review → signing → relaying →
   * done | refused | expired | failed.
   */
  state: ActionState;
  phase: ActionState["phase"];
  /** True while waiting for the network or the wallet. */
  isBusy: boolean;
  /**
   * When the current wait began, in milliseconds: the wallet prompt while
   * `signing`, the relay request while `relaying`. `null` in every other phase.
   */
  since: number | null;
  /** The calls the wallet shows, from the prepared request. `null` before the review. */
  calls: Call[] | null;
  /** The calls that were submitted. `null` until something is. */
  attemptedCalls: Call[] | null;
  /**
   * The two panels, line by line: "Your wallet shows" (`wallet`), "The
   * contract verifies" (`contract`), the lines that differ, and the verdict
   * (`unsigned`, `checking`, `match`, `refused`).
   */
  panels: Panels;
  /** True while a relayer that gave no answer about the call is being asked again. Still sending: nothing has been judged. */
  retrying: boolean;
  /**
   * True when a signed call was handed over and its outcome was never
   * learned. It may have run: this is not a refusal and not a match. The
   * state is `failed` with the sentence to show in `state.error.message`,
   * and `accountLink` is where to look.
   */
  unconfirmed: boolean;
  /** The account on the Stellar explorer, while `unconfirmed`: its activity says what happened. */
  accountLink: string | null;
  /** What the review asks the owner to read and answer before the wallet is asked. Empty outside the review. */
  cautions: Caution[];
  /** The cautions answered so far. */
  confirmed: Caution[];
  /** Answers a caution, or takes the answer back. */
  confirm(caution: Caution, on: boolean): void;
  /** False while a caution of the review is unanswered: `sign` does nothing then. */
  canSign: boolean;
  /** False where the demonstration does not exist: on any network but testnet. */
  canTamper: boolean;
  /** The demo control "Change the amount after signing". Always off where it cannot be used. */
  tamper: boolean;
  setTamper(on: boolean): void;
  /** The relayed transaction on the Stellar explorer, once done. */
  link: string | null;
  /** Simulates the request and opens the review. */
  prepare(request: ActionRequest): Promise<void>;
  /** Signs what the review shows and relays it. With `tamper` on, one argument is altered after signing. */
  sign(options?: SignOptions): Promise<void>;
  /** After `expired`: one click prepares the same request again, signs it and relays it. */
  signAgain(options?: SignOptions): Promise<void>;
  /** From the review back to the form. */
  back(): void;
  reset(): void;
}

const idle = (): ActionState => IDLE_ACTION;
const NO_CAUTIONS: Caution[] = [];
const tamperChoice = createStore(false);
const off = () => false;

/** The outbound flow for the connected owner on `network`. */
export function useAction(network: NetworkName): ActionFlow {
  const signer = useSigner(network);
  const owner = signer.status === "connected" ? signer.address : null;
  const controller = owner ? actionFor(network, owner) : null;
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getState ?? idle, idle);
  const canTamper = network === "testnet";
  const tamperChosen = useSyncExternalStore(tamperChoice.subscribe, tamperChoice.get, off);
  const tamper = canTamper && tamperChosen;

  // Answers belong to the prepared call they were given for: a new one starts with none.
  const reviewed = state.phase === "review" ? state.prepared : null;
  const [answers, setAnswers] = useState<{ of: unknown; confirmed: Caution[] }>({ of: null, confirmed: [] });
  const confirmed = answers.of === reviewed ? answers.confirmed : NO_CAUTIONS;
  const confirm = useCallback(
    (caution: Caution, on: boolean) => {
      setAnswers((current) => {
        const kept = current.of === reviewed ? current.confirmed.filter((other) => other !== caution) : [];
        return { of: reviewed, confirmed: on ? [...kept, caution] : kept };
      });
    },
    [reviewed],
  );

  const settled = state.phase === "done";
  useEffect(() => {
    if (settled && owner) refreshAccount(network, owner);
  }, [settled, owner, network]);

  // A call that got as far as the relayer was signed by the owner's own key: the SDK refuses any other signature.
  const signedAsOwner = state.phase === "relaying" || state.phase === "done" || state.phase === "refused";
  useEffect(() => {
    if (signedAsOwner && owner && !signer.isDemo) rememberKeyProven(network, owner);
  }, [signedAsOwner, owner, network, signer.isDemo]);

  const signTypedData = signer.signTypedData;
  const prepare = useCallback(
    async (request: ActionRequest) => {
      await controller?.prepare(request);
    },
    [controller],
  );
  const sign = useCallback(
    async (options?: SignOptions) => {
      await controller?.sign({ signTypedData }, options ?? { tamper: canTamper && tamperChoice.get(), confirmed });
    },
    [controller, signTypedData, canTamper, confirmed],
  );
  const signAgain = useCallback(
    async (options?: SignOptions) => {
      await controller?.signAgain({ signTypedData }, options ?? { tamper: canTamper && tamperChoice.get() });
    },
    [controller, signTypedData, canTamper],
  );
  const back = useCallback(() => controller?.back(), [controller]);
  const reset = useCallback(() => controller?.reset(), [controller]);

  return useMemo(() => {
    const config = networkConfig(network);
    const submitted = state.phase === "relaying" || state.phase === "done" || state.phase === "refused";
    const cautions = state.phase === "review" ? state.cautions : NO_CAUTIONS;
    return {
      state,
      phase: state.phase,
      isBusy: isActionBusy(state),
      since: state.phase === "signing" || state.phase === "relaying" ? state.since : null,
      calls: "calls" in state ? state.calls : (state.phase === "failed" ? (state.review?.calls ?? null) : null),
      attemptedCalls: submitted ? state.attemptedCalls : null,
      panels: panelsOf(state, (address) => contractName(address, config)),
      retrying: state.phase === "relaying" && state.retrying === true,
      unconfirmed: isUnconfirmed(state),
      accountLink:
        isUnconfirmed(state) && state.phase === "failed" && state.review ? stellarAddress(state.review.prepared.account, network) : null,
      cautions,
      confirmed,
      confirm,
      canSign: cautions.every((caution) => confirmed.includes(caution)),
      canTamper,
      tamper,
      setTamper: (on) => tamperChoice.set(canTamper && on),
      link: state.phase === "done" ? stellarTx(state.hash, network) : null,
      prepare,
      sign,
      signAgain,
      back,
      reset,
    };
  }, [state, network, confirmed, confirm, canTamper, tamper, prepare, sign, signAgain, back, reset]);
}
