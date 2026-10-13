"use client";

import { formatEvmAmount, type NetworkName } from "@paso/sdk";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { Address } from "viem";
import {
  AccountPair,
  ActivityList,
  Cautions,
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
import { deliverCommand, REFUSAL_ON_CHAIN, SCRIPTS_URL } from "@/components/app/site";
import {
  baseAddress,
  formatElapsed,
  networkConfig,
  parseRecipient,
  shortAddress,
  useAction,
  useActivity,
  useExit,
  useFunding,
  useNow,
  useTwin,
  type ActionRequest,
  type ActionState,
  type ActiveSigner,
  type Exit,
  type Funding,
  type RelayerStatus,
} from "@/lib/client";
import { activityRows, declineWords, exitStages, fundingStages, travelProgress, verdictOf } from "./view";

export interface WorkspaceProps {
  /** The network everything here works on: the account's address, the Base it is funded from, the relayer that pays. */
  network: NetworkName;
  signer: ActiveSigner;
  owner: Address;
  /** A recipient handed over by the lookup page. */
  prefillTo: string;
  /** Whether the hosted relayer is there to pay fees on this network. */
  relayer: RelayerStatus;
  /** Where the proof page shows the refusal recorded on mainnet. */
  proofHref: string;
}

/** A transfer that has been under way this long may want explaining, or letting go of. */
const SLOW_AFTER_SECONDS = 90;
const UNSEEN_AFTER_SECONDS = 600;

function fundingStatus(funding: Funding, isDemo: boolean, network: NetworkName): ReactNode {
  const { state, inputError, amountFormatted, elapsedSeconds, tracked, keyCheck, limits } = funding;
  const base = networkConfig(network).evm.chain.name;
  if (inputError) return <span data-tone="problem">{inputError}</span>;

  const stop = tracked ? (
    <StopTracking onStop={funding.stopTracking}>
      The USDC is still yours. It is burned on {base} (<ExternalLink href={tracked.link}>the burn</ExternalLink>) and is minted
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
              {tracked ? <ExternalLink href={tracked.link}>The burn on {base}</ExternalLink> : null}
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
          {state.reason.code === "burn_unconfirmed" ? <FollowBurn chain={base} onFollow={(hash) => funding.resume(hash as `0x${string}`)} /> : null}
        </>
      );
    case "minted":
      return `${amountFormatted ?? ""} USDC arrived${elapsedSeconds === null ? "" : ` in ${formatElapsed(elapsedSeconds)}`}.`;
    case "idle":
      if (state.notice === "cancelled") return "Cancelled in the wallet. Nothing was sent.";
      if (isDemo) return `Test USDC comes from Paso's faucet on ${base}, ${limits.faucetAmountFormatted} at a time.`;
      if (keyCheck.status !== "passed") {
        if (keyCheck.status === "asking") return "Waiting for the signature. It moves nothing.";
        if (keyCheck.problem) return <span data-tone="problem">{keyCheck.problem}</span>;
        return keyCheck.notice === "declined" ? "Declined in the wallet. Nothing was signed." : "The check is asked once per wallet.";
      }
      return limits.ceiling === null
        ? `One transaction on ${base}, about 20 seconds.`
        : `Up to ${formatEvmAmount(limits.ceiling)} USDC a transfer on mainnet: the software has not been audited.`;
    default: {
      const slow = elapsedSeconds !== null && elapsedSeconds > SLOW_AFTER_SECONDS;
      if (state.phase === "attesting" && state.held && tracked) {
        return (
          <div className="held">
            <p>
              The hosted relayer is not delivering right now: {declineWords(state.held, network)}. Your USDC is safe. Circle
              has the burn, and it can be delivered later, by this relayer or by anyone. This page keeps asking.
            </p>
            <p>
              From a checkout of the repository, with any funded Stellar account paying the fee and no key of yours:{" "}
              <code>{deliverCommand(tracked.burnTxHash, network)}</code>
            </p>
            {stop}
          </div>
        );
      }
      let words = `${amountFormatted ? `${amountFormatted} USDC` : "USDC"} on its way${elapsedSeconds === null ? "" : `, ${formatElapsed(elapsedSeconds)}`}.`;
      if (state.phase === "attesting") {
        if (state.attestation === "unreachable") words = `Still waiting: the delivery service is not answering. The burn is safe on ${base}.`;
        else if (state.attestation === "not_found" && elapsedSeconds !== null && elapsedSeconds > UNSEEN_AFTER_SECONDS) {
          words = `Circle has not seen this burn yet. Check it on ${base}: it may not have gone through.`;
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

/** What is said under the tracker of a transfer back to Base, and the step that is the wallet's to make. */
function exitStep(exit: Exit, base: string): ReactNode {
  const { state } = exit;
  if (state.phase === "attested") {
    return (
      <div className="exit-mint">
        <p className="exit-note" data-tone={state.problem ? "problem" : undefined}>
          {state.problem ??
            (state.notice === "declined"
              ? "Declined in the wallet. Nothing was sent; the step is still open."
              : `Attested by Circle. The last step is yours: your wallet submits the mint on ${base} and pays its gas. The USDC goes to the address you signed for.`)}
        </p>
        {exit.canMint ? (
          <button type="button" className="btn btn-inline" onClick={() => void exit.mint()}>
            Confirm the mint in your wallet
          </button>
        ) : (
          <p className="exit-note">This key has no wallet on {base}. Any wallet can submit the mint; connect one to do it from here.</p>
        )}
      </div>
    );
  }
  if (state.phase === "minting") {
    return (
      <p className="exit-note">
        {state.baseTxHash ? `The mint is sent. Waiting for ${base} to confirm it.` : "Confirm the mint in your wallet."}
      </p>
    );
  }
  if (state.phase === "attesting" && state.held) {
    return <p className="exit-note">The hosted relayer is not answering about this transfer right now. The USDC is burned on Stellar and stays yours to mint.</p>;
  }
  if (state.phase === "untracked") {
    return <p className="exit-note">This server cannot follow the mint. Circle attests the burn and it lands on {base} all the same.</p>;
  }
  return null;
}

/** How long a signature that was given and not used up stays good, said next to what became of the call. */
function signatureNote(state: ActionState, now: number | null): ReactNode {
  const review = state.phase === "refused" ? state : state.phase === "failed" && state.stage === "relay" ? state.review : undefined;
  if (!review || now === null) return undefined;
  if (now >= review.expiresAt) return "The signature you gave has run out. It can no longer be used.";
  return `The signature you gave stays good until about ${new Date(review.expiresAt).toLocaleTimeString()}. Until then anyone who holds the signed request can still submit it.`;
}

/** Everything a connected key can do: fund the account, send from it, and watch each signature being checked. */
export function Workspace({ network, signer, owner, prefillTo, relayer, proofHref }: WorkspaceProps) {
  const twin = useTwin(owner, network);
  const funding = useFunding(network);
  const action = useAction(network);
  const exit = useExit(network);
  const activity = useActivity(twin.address, network);
  const now = useNow("slow");
  const { state } = action;
  const second = useNow("second", action.since !== null || state.phase === "review" || state.phase === "refused" || state.phase === "failed");

  const mainnet = network === "mainnet";
  const base = networkConfig(network).evm.chain.name;
  const [burnAmount, setBurnAmount] = useState(mainnet ? "1" : "10");
  const [destination, setDestination] = useState<SendDestination>("stellar");
  const [to, setTo] = useState(prefillTo);
  const [amount, setAmount] = useState("");
  const [attempted, setAttempted] = useState(false);

  const isDemo = signer.isDemo;
  const short = shortAddress(owner);
  const verdict = verdictOf(action);
  const unserved = relayer === "not_serving" || relayer === "not_paying";

  const recipient = parseRecipient(to);
  const toError = !attempted
    ? undefined
    : recipient.kind === "empty"
      ? "Enter who receives it."
      : recipient.kind === "invalid"
        ? recipient.reason
        : destination === "base" && recipient.kind === "stellar"
          ? `Back to ${base} needs an Ethereum address or an ENS name.`
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
  else if (empty) sendStatus = `No USDC here yet. Bring some from ${base} first.`;
  else if (destination === "base") {
    sendStatus = mainnet
      ? `Burned on Stellar. About 20 seconds later your wallet submits the mint on ${base}.`
      : `Burned on Stellar, minted on ${base} about 20 seconds later.`;
  } else if (recipient.kind === "address" || recipient.kind === "ens") sendStatus = "Goes to that address's Stellar account, deployed or not.";
  else sendStatus = "Paso's relayer pays the Stellar fee.";

  const relayed = action.since !== null && second !== null ? formatElapsed((second - action.since) / 1000) : undefined;
  const validFor =
    state.phase === "review" && second !== null ? Math.max(0, Math.round((state.expiresAt - second) / 1000)) : undefined;
  const needsKeyCheck = !isDemo && funding.keyCheck.status !== "passed" && funding.phase === "idle" && !funding.tracked;

  return (
    <>
      <VerdictStrip state={verdict} signer={short} href="#checkpoint" />
      <AccountPair
        evmAddress={owner}
        stellarAddress={twin.address ?? undefined}
        balance={twin.balanceFormatted ?? (twin.status === "error" ? "unknown" : undefined)}
        deployed={twin.deployed ?? undefined}
        evmHref={baseAddress(owner, network)}
        stellarHref={twin.link ?? undefined}
        evmNote={isDemo ? "a throwaway key kept in this browser" : undefined}
      />
      <main className="work" data-network={network}>
        <div className="lefthand">
          {unserved ? (
            <Notice tone="note">
              {relayer === "not_serving"
                ? `The hosted relayer is not serving ${network} right now.`
                : `The hosted relayer is not paying fees on ${network} right now: it has spent its budget for the day, or its account is down to its reserve.`}{" "}
              Everything it does can be done from the repository with <ExternalLink href={SCRIPTS_URL}>the project&rsquo;s scripts</ExternalLink>.
            </Notice>
          ) : null}
          <FundPanel
            mode={isDemo ? "demo" : "wallet"}
            amount={isDemo ? funding.limits.faucetAmountFormatted : burnAmount}
            onAmountChange={setBurnAmount}
            busy={funding.isActive}
            disabled={unserved}
            onSubmit={() => void funding.start(isDemo ? undefined : burnAmount)}
            keyCheck={needsKeyCheck ? { asking: funding.keyCheck.status === "asking", onCheck: () => void funding.checkKey() } : undefined}
            stages={fundingStages(funding)}
            progress={travelProgress(funding.elapsedSeconds)}
            status={fundingStatus(funding, isDemo, network)}
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
            disabled={state.phase === "signing" || state.phase === "relaying" || empty || unserved}
            onSubmit={review}
            status={sendStatus}
          >
            {exit.phase === "idle" ? null : (
              <div className="exit">
                <p>
                  <b>Back to {base}</b>
                  {exit.tracked ? (
                    <StopTracking onStop={exit.stopTracking}>
                      The USDC is still on its way: it is burned on Stellar (
                      <ExternalLink href={exit.tracked.link}>the burn</ExternalLink>) and is minted on {base} whether it is
                      followed here or not.
                    </StopTracking>
                  ) : (
                    <button type="button" className="linkbtn" onClick={exit.stopTracking}>
                      Hide
                    </button>
                  )}
                </p>
                <Tracker compact stages={exitStages(exit)} />
                {exitStep(exit, base)}
                {exit.tracked && !exit.tracked.saved ? (
                  <p className="exit-note">This browser keeps no storage, so a reload forgets the tracker. The USDC is unaffected.</p>
                ) : null}
              </div>
            )}
          </SendForm>
        </div>
        <div className="righthand">
          <section className="gate" id="checkpoint" aria-label="Signature check" data-network={network}>
            <p className="gate-net">
              <b>Stellar {network}.</b>{" "}
              {mainnet ? "What you sign here moves real USDC." : "Test funds only. A signature made here is not good on mainnet."}
            </p>
            <MessagePanels wallet={action.panels.wallet} contract={action.panels.contract} loading={state.phase === "preparing"} />
            <Verdict
              state={verdict}
              signer={short}
              txHref={action.link ?? undefined}
              reason={state.phase === "refused" ? state.reason : state.phase === "failed" ? state.error.message : undefined}
              elapsed={relayed}
              validFor={validFor}
              networkName={`Stellar ${network}`}
              tamper={action.tamper}
              declined={state.phase === "review" && state.notice === "rejected"}
              retrying={action.retrying}
              accountHref={action.accountLink ?? undefined}
              signatureNote={signatureNote(state, second ?? now)}
              caution={<Cautions cautions={action.cautions} confirmed={action.confirmed} onConfirm={action.confirm} />}
              canSign={action.canSign}
              exampleHref={REFUSAL_ON_CHAIN[network]}
              onSign={() => void action.sign()}
              onBack={action.back}
              onSignAgain={() => (state.phase === "failed" ? void action.prepare(state.request) : void action.signAgain())}
              onReset={action.reset}
            />
            {action.canTamper ? (
              <TamperSwitch
                checked={action.tamper}
                onChange={action.setTamper}
                disabled={state.phase === "signing" || state.phase === "relaying"}
              />
            ) : (
              <p className="tamper-absent">
                Changing a call after signing can be tried on testnet. On mainnet it has been done once, on purpose:{" "}
                <Link href={proofHref}>the refusal recorded on mainnet</Link>.
              </p>
            )}
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
