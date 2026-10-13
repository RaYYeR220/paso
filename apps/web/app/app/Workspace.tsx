"use client";

import { formatEvmAmount, isEvmChainName, type EvmChainConfig, type EvmChainName, type NetworkName } from "@paso/sdk";
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
  Skeleton,
  StopTracking,
  TamperSwitch,
  Tracker,
  Verdict,
  VerdictStrip,
  type ChainChoiceOption,
  type SendDestination,
} from "@/components/app";
import { deliverCommand, REFUSAL_ON_CHAIN, SCRIPTS_URL } from "@/components/app/site";
import {
  chainOf,
  chainsOf,
  evmAddress,
  FAUCET_CHAIN,
  formatElapsed,
  gasSymbol,
  networkConfig,
  parseRecipient,
  serverMintsOn,
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
  /** The network everything here works on: the account's address, the chains it is funded from, the relayer that pays. */
  network: NetworkName;
  signer: ActiveSigner;
  owner: Address;
  /** A recipient handed over by the lookup page. */
  prefillTo: string;
  /** Whether the hosted relayer is there to pay fees on this network. */
  relayer: RelayerStatus;
  /** Whether the server submits the mint that ends a transfer back to Base on this network. Everywhere else the wallet does. */
  paysBaseMints: boolean;
  /** Where the proof page shows the refusal recorded on mainnet. */
  proofHref: string;
}

/** A transfer that has been under way this long may want explaining, or letting go of. */
const SLOW_AFTER_SECONDS = 90;
const UNSEEN_AFTER_SECONDS = 600;

/** Circle's fee for the route, as a sentence to follow another: nothing until Circle has said. */
function feeWords(chain: EvmChainConfig, bps: number | null): string {
  if (bps === null) return "";
  if (bps === 0) return ` Circle charges no fee from ${chain.shortLabel}.`;
  return ` Circle keeps ${Number((bps / 100).toFixed(4))}% of it.`;
}

/** What the wallet holds on the chain in view, with where to get test funds when it holds none. */
function holdingsNote(funding: Funding, network: NetworkName): ReactNode {
  const { chain, holdings } = funding;
  if (!holdings) {
    return `The demo key brings test USDC from ${chainOf(networkConfig(network), FAUCET_CHAIN).label} only. Connect a wallet to bring it from another chain.`;
  }
  const where = `In the wallet on ${chain.label}: `;
  if (holdings.usdc === null) {
    return (
      <>
        {where}
        <Skeleton width="8em" />
      </>
    );
  }
  const faucets = chain.faucets && (holdings.noUsdc || holdings.noGas) ? chain.faucets : null;
  if (chain.gasToken.isUsdc) {
    return (
      <>
        {where}
        {holdings.usdc} USDC. Gas is paid in USDC on {chain.shortLabel}.
        {faucets ? (
          <>
            {" "}
            Test USDC, gas included: <ExternalLink href={faucets.usdc}>Circle&rsquo;s faucet</ExternalLink>.
          </>
        ) : null}
      </>
    );
  }
  const gas = gasSymbol(chain);
  return (
    <>
      {where}
      {holdings.usdc} USDC and {holdings.gas} {gas} for gas.
      {faucets ? (
        <>
          {" "}
          Test USDC from <ExternalLink href={faucets.usdc}>Circle&rsquo;s faucet</ExternalLink>, {gas} from{" "}
          <ExternalLink href={faucets.gas}>a {chain.label} faucet</ExternalLink>.
        </>
      ) : null}
    </>
  );
}

function fundingStatus(funding: Funding, isDemo: boolean, network: NetworkName): ReactNode {
  const { state, inputError, amountFormatted, elapsedSeconds, tracked, keyCheck, limits, chain } = funding;
  const where = chain.label;
  if (inputError) return <span data-tone="problem">{inputError}</span>;

  const stop = tracked ? (
    <StopTracking onStop={funding.stopTracking}>
      The USDC is still yours. It is burned on {where} (<ExternalLink href={tracked.link}>the burn</ExternalLink>) and is minted
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
              {tracked ? <ExternalLink href={tracked.link}>The burn on {where}</ExternalLink> : null}
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
          {state.reason.code === "burn_unconfirmed" ? <FollowBurn chain={where} onFollow={(hash) => funding.resume(hash as `0x${string}`)} /> : null}
        </>
      );
    case "minted":
      return `${amountFormatted ?? ""} USDC arrived${elapsedSeconds === null ? "" : ` in ${formatElapsed(elapsedSeconds)}`}.`;
    case "idle":
      if (state.notice === "cancelled") return "Cancelled in the wallet. Nothing was sent.";
      if (isDemo) return `Test USDC comes from Paso's faucet on ${where}, ${limits.faucetAmountFormatted} at a time.`;
      if (keyCheck.status !== "passed") {
        if (keyCheck.status === "asking") return "Waiting for the signature. It moves nothing.";
        if (keyCheck.problem) return <span data-tone="problem">{keyCheck.problem}</span>;
        return keyCheck.notice === "declined" ? "Declined in the wallet. Nothing was signed." : "The check is asked once per wallet.";
      }
      const fee = feeWords(chain, funding.feeBps);
      return limits.ceiling === null
        ? `One transaction on ${where}, ${chain.fastTransfer ? "about 20 seconds" : "attested within seconds"}.${fee}`
        : `Up to ${formatEvmAmount(limits.ceiling)} USDC a transfer on mainnet: the software has not been audited.${fee}`;
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
        if (state.attestation === "unreachable") words = `Still waiting: the delivery service is not answering. The burn is safe on ${where}.`;
        else if (state.attestation === "not_found" && elapsedSeconds !== null && elapsedSeconds > UNSEEN_AFTER_SECONDS) {
          words = `Circle has not seen this burn yet. Check it on ${where}: it may not have gone through.`;
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

/** What is said under the tracker of a transfer back to an EVM chain, and the step that is the wallet's to make. */
function exitStep(exit: Exit): ReactNode {
  const { state, chain } = exit;
  if (!chain) return null;
  const where = chain.label;
  if (state.phase === "attested") {
    const gas = chain.gasToken.isUsdc ? `its gas, in USDC on ${chain.shortLabel}` : "its gas";
    return (
      <div className="exit-mint">
        <p className="exit-note" data-tone={state.problem ? "problem" : undefined}>
          {state.problem ??
            (state.notice === "declined"
              ? "Declined in the wallet. Nothing was sent; the step is still open."
              : `Attested by Circle. The last step is yours: your wallet submits the mint on ${where} and pays ${gas}. The USDC goes to the address you signed for.`)}
        </p>
        {exit.canMint ? (
          <button type="button" className="btn btn-inline" onClick={() => void exit.mint()}>
            Confirm the mint in your wallet
          </button>
        ) : (
          <p className="exit-note">This key has no wallet on {where}. Any wallet can submit the mint; connect one to do it from here.</p>
        )}
      </div>
    );
  }
  if (state.phase === "minting") {
    return (
      <p className="exit-note">
        {state.mintTxHash ? `The mint is sent. Waiting for ${where} to confirm it.` : "Confirm the mint in your wallet."}
      </p>
    );
  }
  if (state.phase === "attesting" && state.held) {
    return <p className="exit-note">The hosted relayer is not answering about this transfer right now. The USDC is burned on Stellar and stays yours to mint.</p>;
  }
  if (state.phase === "untracked") {
    return <p className="exit-note">This server cannot follow the mint. Circle attests the burn and it lands on {where} all the same.</p>;
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
export function Workspace({ network, signer, owner, prefillTo, relayer, paysBaseMints, proofHref }: WorkspaceProps) {
  const [fundChain, setFundChain] = useState<EvmChainName>(FAUCET_CHAIN);
  // The way back goes to the chain the USDC came from until another is picked for it.
  const [exitChoice, setExitChoice] = useState<EvmChainName | null>(null);
  const exitChain = exitChoice ?? fundChain;
  const twin = useTwin(owner, network);
  const funding = useFunding(network, fundChain);
  const action = useAction(network);
  const exit = useExit(network);
  const activity = useActivity(twin.address, network);
  const now = useNow("slow");
  const { state } = action;
  const second = useNow("second", action.since !== null || state.phase === "review" || state.phase === "refused" || state.phase === "failed");

  const mainnet = network === "mainnet";
  const config = networkConfig(network);
  const [burnAmount, setBurnAmount] = useState(mainnet ? "1" : "10");
  const [destination, setDestination] = useState<SendDestination>("stellar");
  const [to, setTo] = useState(prefillTo);
  const [amount, setAmount] = useState("");
  const [attempted, setAttempted] = useState(false);

  const isDemo = signer.isDemo;
  // The demo key has no wallet: it is funded on Base Sepolia, and goes back there, where Paso submits the mint.
  const back = chainOf(config, isDemo ? FAUCET_CHAIN : exitChain);
  const chainOptions = (available: (name: EvmChainName) => boolean): ChainChoiceOption[] =>
    chainsOf(config).map((chain) => ({ name: chain.name, label: chain.shortLabel, available: available(chain.name) }));
  const choose = (set: (name: EvmChainName) => void) => (name: string) => {
    if (isEvmChainName(name)) set(name);
  };
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
        : destination === "evm" && recipient.kind === "stellar"
          ? `Back to ${back.shortLabel} needs an Ethereum address or an ENS name.`
          : undefined;
  const amountError = attempted && !amount.trim() ? "Enter an amount." : undefined;
  const prepareProblem = state.phase === "failed" && state.stage === "prepare" ? state.error.message : undefined;

  const review = () => {
    setAttempted(true);
    if (recipient.kind === "empty" || recipient.kind === "invalid" || !amount.trim()) return;
    if (destination === "evm" && recipient.kind === "stellar") return;
    const request: ActionRequest =
      destination === "evm"
        ? { kind: "exit", recipient: to.trim(), amount: amount.trim(), chain: back.name }
        : { kind: "transfer", to: to.trim(), amount: amount.trim() };
    void action.prepare(request);
  };

  const chooseDestination = (next: SendDestination) => {
    setDestination(next);
    // Back to an EVM chain goes to the connected wallet unless another address is typed.
    if (next === "evm" && (recipient.kind === "empty" || recipient.kind === "stellar")) setTo(owner);
  };

  const empty = twin.balance !== null && twin.balance === 0n;
  let sendStatus: ReactNode;
  if (state.phase === "preparing") sendStatus = "Simulating the call on Stellar.";
  else if (empty) sendStatus = "No USDC here yet. Bring some over first.";
  else if (destination === "evm") {
    sendStatus = serverMintsOn(back.name, paysBaseMints)
      ? `Burned on Stellar, minted on ${back.label} about 20 seconds later.`
      : `Burned on Stellar. About 20 seconds later your wallet submits the mint on ${back.label}${back.gasToken.isUsdc ? " and pays its gas in USDC" : ""}.`;
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
        evmHref={evmAddress(owner, network, funding.chain.name)}
        evmHrefLabel={funding.chain.shortLabel}
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
            chain={funding.chain.shortLabel}
            chains={funding.chains.map(({ chain, available }) => ({ name: chain.name, label: chain.shortLabel, available }))}
            chainName={funding.chain.name}
            onChainChange={(name) => {
              // A finished or failed request belongs to the chain it was for: a new chain starts from a clean panel.
              choose(setFundChain)(name);
              funding.reset();
            }}
            chainLocked={funding.chainLocked}
            chainNote={holdingsNote(funding, network)}
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
            chain={back.shortLabel}
            chains={chainOptions((name) => !isDemo || name === FAUCET_CHAIN)}
            chainName={back.name}
            onChainChange={choose(setExitChoice)}
            chainNote={
              isDemo
                ? `With the demo key USDC goes back to ${back.label} only, where Paso submits the mint. Connect a wallet to send it back to another chain.`
                : undefined
            }
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
            {exit.phase === "idle" || !exit.chain ? null : (
              <div className="exit">
                <p>
                  <b>Back to {exit.chain.shortLabel}</b>
                  {exit.tracked ? (
                    <StopTracking onStop={exit.stopTracking}>
                      The USDC is still on its way: it is burned on Stellar (
                      <ExternalLink href={exit.tracked.link}>the burn</ExternalLink>) and is minted on {exit.chain.label} whether
                      it is followed here or not.
                    </StopTracking>
                  ) : (
                    <button type="button" className="linkbtn" onClick={exit.stopTracking}>
                      Hide
                    </button>
                  )}
                </p>
                <Tracker compact stages={exitStages(exit)} />
                {exitStep(exit)}
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
