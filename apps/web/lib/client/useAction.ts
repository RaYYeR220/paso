"use client";

import type { Call } from "@paso/sdk";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { SignOptions } from "./action/controller";
import {
  IDLE_ACTION,
  isActionBusy,
  panelsOf,
  type ActionRequest,
  type ActionState,
} from "./action/machine";
import type { Panels } from "./action/panels";
import { contractName } from "./config";
import { stellarTx } from "./explorer";
import { actionFor, refreshAccount } from "./registry";
import { useSigner } from "./signer";
import { createStore, noSubscription } from "./store";

/** Having the connected owner's account do something: a transfer, a withdrawal to Base, or any contract call. */
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
  /** True while a relayer that was unavailable is being asked a second time. Still sending: nothing has been judged. */
  retrying: boolean;
  /** The demo control "Change the amount after signing". */
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
const tamperChoice = createStore(false);
const off = () => false;

/** The outbound flow for the connected owner. */
export function useAction(): ActionFlow {
  const signer = useSigner();
  const owner = signer.status === "connected" ? signer.address : null;
  const controller = owner ? actionFor(owner) : null;
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getState ?? idle, idle);
  const tamper = useSyncExternalStore(tamperChoice.subscribe, tamperChoice.get, off);

  const settled = state.phase === "done";
  useEffect(() => {
    if (settled && owner) refreshAccount(owner);
  }, [settled, owner]);

  const signTypedData = signer.signTypedData;
  const prepare = useCallback(
    async (request: ActionRequest) => {
      await controller?.prepare(request);
    },
    [controller],
  );
  const sign = useCallback(
    async (options?: SignOptions) => {
      await controller?.sign({ signTypedData }, options ?? { tamper: tamperChoice.get() });
    },
    [controller, signTypedData],
  );
  const signAgain = useCallback(
    async (options?: SignOptions) => {
      await controller?.signAgain({ signTypedData }, options ?? { tamper: tamperChoice.get() });
    },
    [controller, signTypedData],
  );
  const back = useCallback(() => controller?.back(), [controller]);
  const reset = useCallback(() => controller?.reset(), [controller]);

  return useMemo(() => {
    const submitted = state.phase === "relaying" || state.phase === "done" || state.phase === "refused";
    return {
      state,
      phase: state.phase,
      isBusy: isActionBusy(state),
      since: state.phase === "signing" || state.phase === "relaying" ? state.since : null,
      calls: "calls" in state ? state.calls : (state.phase === "failed" ? (state.review?.calls ?? null) : null),
      attemptedCalls: submitted ? state.attemptedCalls : null,
      panels: panelsOf(state, contractName),
      retrying: state.phase === "relaying" && state.retrying === true,
      tamper,
      setTamper: tamperChoice.set,
      link: state.phase === "done" ? stellarTx(state.hash) : null,
      prepare,
      sign,
      signAgain,
      back,
      reset,
    };
  }, [state, tamper, prepare, sign, signAgain, back, reset]);
}
