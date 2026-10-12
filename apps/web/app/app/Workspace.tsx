"use client";

import { useState, type ReactNode } from "react";
import type { Address } from "viem";
import {
  AccountPair,
  ActivityList,
  ExternalLink,
  FollowBurn,
  FundPanel,
  MessagePanels,
  Notice,
  SendForm,
  StopTracking,
  TamperSwitch,
  Tracker,
  Verdict,
  VerdictStrip,
  type SendDestination,
} from "@/components/app";
import { REFUSAL_ON_CHAIN } from "@/components/app/site";
import {
  NETWORK,
  baseAddress,
  formatElapsed,
  parseRecipient,
  shortAddress,
  useAction,
  useActivity,
  useExit,
  useFunding,
  useNow,
  useTwin,
  type ActionRequest,
  type ActiveSigner,
  type Funding,
} from "@/lib/client";
import { activityRows, exitStages, fundingStages, travelProgress, verdictOf } from "./view";

export interface WorkspaceProps {
  signer: ActiveSigner;
  owner: Address;
  /** A recipient handed over by the lookup page. */
  prefillTo: string;
}

const BASE = NETWORK.evm.chain.name;

/** A transfer that has been under way this long may want explaining, or letting go of. */
const SLOW_AFTER_SECONDS = 90;
const UNSEEN_AFTER_SECONDS = 600;

function fundingStatus(funding: Funding, isDemo: boolean): ReactNode {
  const { state, inputError, amountFormatted, elapsedSeconds, tracked } = funding;
  if (inputError) return <span data-tone="problem">{inputError}</span>;

  const stop = tracked ? (
    <StopTracking onStop={funding.stopTracking}>
      The USDC is still yours. It is burned on {BASE} (<ExternalLink href={tracked.link}>the burn</ExternalLink>) and is minted
      to this account whenever the burn is delivered, followed here or not.
    </StopTracking>
  ) : null;

  switch (state.phase) {
    case "failed":
      if (state.transfer) {
        return (
          <>
            <Notice actionLabel="Ask again" onAction={() => void funding.retry()} detail={state.reason.detail}>
              {state.reason.message}{" "}
              {tracked ? <ExternalLink href={tracked.link}>The burn on {BASE}</ExternalLink> : null}
            </Notice>
            {stop}
          </>
        );
      }
      return (
        <>
          <Notice
            actionLabel="Dismiss"
            onAction={funding.reset}
            retryAfterSeconds={state.reason.retryAfterSeconds}
            detail={state.reason.detail}
          >
            {state.reason.message}
          </Notice>
          {state.reason.code === "burn_unconfirmed" ? <FollowBurn chain={BASE} onFollow={(hash) => funding.resume(hash as `0x${string}`)} /> : null}
        </>
      );
    case "minted":
      return `${amountFormatted ?? ""} USDC arrived${elapsedSeconds === null ? "" : ` in ${formatElapsed(elapsedSeconds)}`}.`;
    case "idle":
      if (state.notice === "cancelled") return "Cancelled in the wallet. Nothing was sent.";
      return isDemo
        ? `Test USDC comes from Paso's faucet on ${BASE}, ${funding.limits.faucetAmountFormatted} at a time.`
        : `One transaction on ${BASE}, about 20 seconds.`;
    default: {
      const slow = elapsedSeconds !== null && elapsedSeconds > SLOW_AFTER_SECONDS;
      let words = `${amountFormatted ? `${amountFormatted} USDC` : "USDC"} on its way${elapsedSeconds === null ? "" : `, ${formatElapsed(elapsedSeconds)}`}.`;
      if (state.phase === "attesting") {
        if (state.attestation === "unreachable") words = `Still waiting: the delivery service is not answering. The burn is safe on ${BASE}.`;
        else if (state.attestation === "not_found" && elapsedSeconds !== null && elapsedSeconds > UNSEEN_AFTER_SECONDS) {
          words = `Circle has not seen this burn yet. Check it on ${BASE}: it may not have gone through.`;
        } else if (state.delayReason) words = `Circle is holding the transfer back: ${state.delayReason}.`;
      }
      return (
        <>
          {words}
          {tracked && !tracked.saved ? " This browser keeps no storage, so a reload forgets the tracker. The USDC is unaffected." : null}
          {slow ? <> {stop}</> : null}
        </>
      );
    }
  }
}

/** Everything a connected key can do: fund the account, send from it, and watch each signature being checked. */
export function Workspace({ signer, owner, prefillTo }: WorkspaceProps) {
  const twin = useTwin(owner);
  const funding = useFunding();
  const action = useAction();
  const exit = useExit();
  const activity = useActivity(twin.address);
  const now = useNow("slow");
  const second = useNow("second", action.since !== null);

  const [burnAmount, setBurnAmount] = useState("10");
  const [destination, setDestination] = useState<SendDestination>("stellar");
  const [to, setTo] = useState(prefillTo);
  const [amount, setAmount] = useState("");
  const [attempted, setAttempted] = useState(false);

  const isDemo = signer.isDemo;
  const short = shortAddress(owner);
  const verdict = verdictOf(action);
  const { state } = action;

  const recipient = parseRecipient(to);
  const toError = !attempted
    ? undefined
    : recipient.kind === "empty"
      ? "Enter who receives it."
      : recipient.kind === "invalid"
        ? recipient.reason
        : destination === "base" && recipient.kind === "stellar"
          ? `Back to ${BASE} needs an Ethereum address or an ENS name.`
          : undefined;
  const amountError = attempted && !amount.trim() ? "Enter an amount." : undefined;
  const prepareProblem = state.phase === "failed" && state.stage === "prepare" ? state.error.message : undefined;

  const review = () => {
    setAttempted(true);
    if (recipient.kind === "empty" || recipient.kind === "invalid" || !amount.trim()) return;
    if (destination === "base" && recipient.kind === "stellar") return;
    const request: ActionRequest =
      destination === "base"
        ? { kind: "exit", recipient: to.trim(), amount: amount.trim() }
        : { kind: "transfer", to: to.trim(), amount: amount.trim() };
    void action.prepare(request);
  };

  const chooseDestination = (next: SendDestination) => {
    setDestination(next);
    if (next === "base" && (recipient.kind === "empty" || recipient.kind === "stellar")) setTo(owner);
  };

  const empty = twin.balance !== null && twin.balance === 0n;
  let sendStatus: ReactNode;
  if (state.phase === "preparing") sendStatus = "Simulating the call on Stellar.";
  else if (empty) sendStatus = `No USDC here yet. Bring some from ${BASE} first.`;
  else if (destination === "base") sendStatus = `Burned on Stellar, minted on ${BASE} about 20 seconds later.`;
  else if (recipient.kind === "address" || recipient.kind === "ens") sendStatus = "Goes to that address's Stellar account, deployed or not.";
  else sendStatus = "Paso's relayer pays the Stellar fee.";

  const relayed = action.since !== null && second !== null ? formatElapsed((second - action.since) / 1000) : undefined;

  return (
    <>
      <VerdictStrip state={verdict} signer={short} href="#checkpoint" />
      <AccountPair
        evmAddress={owner}
        stellarAddress={twin.address ?? undefined}
        balance={twin.balanceFormatted ?? (twin.status === "error" ? "unknown" : undefined)}
        deployed={twin.deployed ?? undefined}
        evmHref={baseAddress(owner)}
        stellarHref={twin.link ?? undefined}
        evmNote={isDemo ? "a throwaway key kept in this browser" : undefined}
      />
      <main className="work">
        <div className="lefthand">
          <FundPanel
            mode={isDemo ? "demo" : "wallet"}
            amount={isDemo ? funding.limits.faucetAmountFormatted : burnAmount}
            onAmountChange={setBurnAmount}
            busy={funding.isActive}
            onSubmit={() => void funding.start(isDemo ? undefined : burnAmount)}
            stages={fundingStages(funding)}
            progress={travelProgress(funding.elapsedSeconds)}
            status={fundingStatus(funding, isDemo)}
          />
          <SendForm
            destination={destination}
            onDestinationChange={chooseDestination}
            to={to}
            onToChange={setTo}
            toError={toError}
            amount={amount}
            onAmountChange={setAmount}
            amountError={amountError}
            problem={prepareProblem}
            preparing={state.phase === "preparing"}
            disabled={state.phase === "signing" || state.phase === "relaying" || empty}
            onSubmit={review}
            status={sendStatus}
          >
            {exit.phase === "idle" ? null : (
              <div className="exit">
                <p>
                  <b>Back to {BASE}</b>
                  {exit.tracked ? (
                    <StopTracking onStop={exit.stopTracking}>
                      The USDC is still on its way: it is burned on Stellar (
                      <ExternalLink href={exit.tracked.link}>the burn</ExternalLink>) and is minted on {BASE} whether it is
                      followed here or not.
                    </StopTracking>
                  ) : (
                    <button type="button" className="linkbtn" onClick={exit.stopTracking}>
                      Hide
                    </button>
                  )}
                </p>
                <Tracker compact stages={exitStages(exit)} />
                {exit.phase === "untracked" ? (
                  <p className="exit-note">This server cannot follow the mint. Circle attests the burn and it lands on {BASE} all the same.</p>
                ) : null}
                {exit.tracked && !exit.tracked.saved ? (
                  <p className="exit-note">This browser keeps no storage, so a reload forgets the tracker. The USDC is unaffected.</p>
                ) : null}
              </div>
            )}
          </SendForm>
        </div>
        <div className="righthand">
          <section className="gate" id="checkpoint" aria-label="Signature check">
            <MessagePanels wallet={action.panels.wallet} contract={action.panels.contract} loading={state.phase === "preparing"} />
            <Verdict
              state={verdict}
              signer={short}
              txHref={action.link ?? undefined}
              reason={state.phase === "refused" ? state.reason : state.phase === "failed" ? state.error.message : undefined}
              elapsed={relayed}
              tamper={action.tamper}
              declined={state.phase === "review" && state.notice === "rejected"}
              retrying={action.retrying}
              exampleHref={REFUSAL_ON_CHAIN}
              onSign={() => void action.sign()}
              onBack={action.back}
              onSignAgain={() => (state.phase === "failed" ? void action.prepare(state.request) : void action.signAgain())}
              onReset={action.reset}
            />
            <TamperSwitch
              checked={action.tamper}
              onChange={action.setTamper}
              disabled={state.phase === "signing" || state.phase === "relaying"}
            />
          </section>
          <ActivityList
            items={activityRows(activity.items, now)}
            loading={activity.status === "loading" || activity.status === "idle"}
            footnote={activity.error ? "Stellar did not answer. Showing what this browser remembers." : undefined}
          />
        </div>
      </main>
    </>
  );
}
