"use client";

import { useState, type CSSProperties, type FormEvent } from "react";
import {
  DEMO_LABEL,
  NETWORK,
  NETWORK_NAME,
  baseAddress,
  formatElapsed,
  formatWait,
  relativeTime,
  shortAddress,
  shortHash,
  useAction,
  useActivity,
  useFunding,
  useHealth,
  useNow,
  useSigner,
  useTwin,
  type ActionFlow,
  type ActiveSigner,
  type Funding,
  type PanelLine,
  type Twin,
} from "@/lib/client";
import { parseArguments } from "@/lib/client/action/args";
import { stellarServer } from "@/lib/client/config";

/** Just enough to see where a field or a button is. Everything else about the look is left open. */
const field: CSSProperties = { border: "1px solid", padding: "2px 6px" };
const page: CSSProperties = { padding: 16, display: "grid", gap: 24 };

export default function AppPage() {
  const signer = useSigner();
  const connected = signer.status === "connected";
  const twin = useTwin(connected ? signer.address : null);

  return (
    <main style={page}>
      <TopBar signer={signer} />
      {connected ? (
        <>
          <Account signer={signer} twin={twin} />
          <BringUsdc />
          <Act twin={twin} />
          <ActivityList account={twin.address} />
        </>
      ) : (
        <Connect signer={signer} />
      )}
    </main>
  );
}

function TopBar({ signer }: { signer: ActiveSigner }) {
  return (
    <header>
      <h1>Paso</h1>
      <p>
        Network: {NETWORK_NAME === "testnet" ? "Testnet" : "Mainnet"}
        {signer.address ? (
          <>
            {" · "}connected {shortAddress(signer.address)} ({signer.isDemo ? "demo key" : (signer.wallet.walletName ?? "wallet")}){" "}
            <button type="button" style={field} onClick={() => void signer.disconnect()}>
              Disconnect
            </button>
          </>
        ) : null}
      </p>
    </header>
  );
}

function Connect({ signer }: { signer: ActiveSigner }) {
  const connecting = signer.wallet.status === "connecting";
  return (
    <section aria-labelledby="connect">
      <h2 id="connect">Connect</h2>
      <ul>
        {signer.wallet.options.map((option) => (
          <li key={option.id}>
            <button type="button" style={field} disabled={connecting} onClick={() => void signer.wallet.connect(option.id)}>
              Connect {option.name}
            </button>
          </li>
        ))}
        <li>
          <button type="button" style={field} onClick={() => void signer.demo.connect()}>
            Try it without a wallet
          </button>{" "}
          <small>Makes a throwaway key in this browser. Testnet only.</small>
        </li>
      </ul>
      {connecting ? <p role="status">Waiting for the wallet…</p> : null}
      {signer.error ? <p role="alert">{signer.error}</p> : null}
    </section>
  );
}

function Account({ signer, twin }: { signer: ActiveSigner; twin: Twin }) {
  return (
    <section aria-labelledby="account">
      <h2 id="account">Account</h2>
      <dl>
        <dt>Ethereum</dt>
        <dd>
          <a href={signer.address ? baseAddress(signer.address) : undefined} target="_blank" rel="noreferrer">
            <code>{signer.address}</code>
          </a>
        </dd>
        <dt>Stellar (same key)</dt>
        <dd>
          <a href={twin.link ?? undefined} target="_blank" rel="noreferrer">
            <code>{twin.address ?? "—"}</code>
          </a>
        </dd>
        <dt>Balance</dt>
        <dd>
          {twin.balanceFormatted === null ? (twin.status === "error" ? "unknown" : "…") : `${twin.balanceFormatted} USDC`}{" "}
          <button type="button" style={field} disabled={twin.refreshing} onClick={() => void twin.refresh()}>
            Refresh
          </button>
        </dd>
        <dt>Status</dt>
        <dd>
          {twin.deployed === null ? "…" : twin.deployed ? "deployed" : "not deployed yet · can already receive"}
        </dd>
      </dl>
      {signer.isDemo ? (
        <p>
          <small>{DEMO_LABEL}.</small>{" "}
          <button type="button" style={field} onClick={() => void signer.demo.renew()}>
            New demo key
          </button>
        </p>
      ) : null}
      {twin.error ? <p role="alert">{twin.error}</p> : null}
    </section>
  );
}

function BringUsdc() {
  const funding = useFunding();
  const health = useHealth();
  const [amount, setAmount] = useState("10");
  const [burnHash, setBurnHash] = useState("");
  const { state } = funding;
  const chain = NETWORK.evm.chain.name;

  return (
    <section aria-labelledby="bring">
      <h2 id="bring">Bring USDC from Base</h2>
      {funding.via === "demo" ? (
        <p>
          <button type="button" style={field} disabled={funding.isActive} onClick={() => void funding.start()}>
            Get 1 test USDC from the faucet
          </button>{" "}
          <small>
            Faucet:{" "}
            {{ ready: "ready", empty: "out of funds", off: "switched off", unknown: "status unknown" }[health.faucet]}
          </small>
        </p>
      ) : (
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void funding.start(amount);
          }}
        >
          <label>
            Amount (USDC on {chain}){" "}
            <input style={field} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </label>{" "}
          <button type="submit" style={field} disabled={funding.isActive}>
            Bring it over
          </button>
        </form>
      )}
      {funding.inputError ? <p role="alert">{funding.inputError}</p> : null}

      {state.phase !== "idle" ? <Tracker funding={funding} /> : null}
      {state.phase === "idle" && state.notice === "cancelled" ? <p role="status">Cancelled in the wallet. Nothing was sent.</p> : null}

      <details>
        <summary>Follow a burn you already made</summary>
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            funding.resume(burnHash.trim() as `0x${string}`);
          }}
        >
          <label>
            Burn transaction on {chain}{" "}
            <input style={field} size={70} value={burnHash} placeholder="0x…" onChange={(event) => setBurnHash(event.target.value)} />
          </label>{" "}
          <button type="submit" style={field} disabled={funding.isActive}>
            Follow
          </button>
        </form>
      </details>
    </section>
  );
}

function Tracker({ funding }: { funding: Funding }) {
  const { state, stages, links } = funding;
  const burnHash = "transfer" in state && state.transfer ? state.transfer.burnTxHash : null;
  return (
    <div role="status">
      <p>
        {funding.amountFormatted ? `${funding.amountFormatted} USDC` : "USDC"} · phase: <code>{state.phase}</code>
        {state.phase === "requesting" ? ` (${state.step})` : null}
        {funding.elapsedSeconds !== null ? ` · ${formatElapsed(funding.elapsedSeconds)}` : null}
      </p>
      <ol>
        {stages.map((stage) => (
          <li key={stage.id} data-status={stage.status}>
            {stage.label} — {stage.status}
            {stage.id === "burned" && links.base ? (
              <>
                {" "}
                <a href={links.base} target="_blank" rel="noreferrer">
                  {burnHash ? shortHash(burnHash) : "Base"} ↗
                </a>
              </>
            ) : null}
            {stage.id === "attested" && state.phase === "attesting" && state.delayReason ? ` (${state.delayReason})` : null}
            {stage.id === "minted" && links.stellar ? (
              <>
                {" "}
                <a href={links.stellar} target="_blank" rel="noreferrer">
                  Stellar ↗
                </a>
              </>
            ) : null}
          </li>
        ))}
      </ol>
      {state.phase === "failed" ? (
        <p role="alert">
          {state.reason.message}
          {state.reason.retryAfterSeconds ? ` Try again in ${formatWait(state.reason.retryAfterSeconds)}.` : null}{" "}
          <small>
            (<code>{state.reason.code}</code>)
          </small>{" "}
          {state.transfer && state.reason.retryable ? (
            <button type="button" style={field} onClick={() => funding.retry()}>
              Pick it up again
            </button>
          ) : null}
        </p>
      ) : null}
      {state.phase === "minted" || state.phase === "failed" ? (
        <button type="button" style={field} onClick={funding.reset}>
          Done
        </button>
      ) : null}
    </div>
  );
}

function Act({ twin }: { twin: Twin }) {
  const action = useAction();
  const { phase } = action;
  const inForm = phase === "idle" || phase === "preparing" || (phase === "failed" && action.state.phase === "failed" && action.state.stage === "prepare");

  return (
    <section aria-labelledby="act">
      <h2 id="act">Send</h2>
      {inForm ? <Forms action={action} twin={twin} /> : <Review action={action} />}
      {action.state.phase === "idle" && action.state.notice === "rejected" ? <p role="status">Declined in the wallet.</p> : null}
      {action.state.phase === "failed" && action.state.stage === "prepare" ? (
        <p role="alert">
          {action.state.error.message}{" "}
          <small>
            (<code>{action.state.error.code}</code>)
          </small>
        </p>
      ) : null}
    </section>
  );
}

function Forms({ action, twin }: { action: ActionFlow; twin: Twin }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("5");
  const [exitTo, setExitTo] = useState(twin.owner ?? "");
  const [exitAmount, setExitAmount] = useState("1");
  const [contract, setContract] = useState(NETWORK.stellar.usdc);
  const [fn, setFn] = useState("approve");
  const [args, setArgs] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const busy = action.isBusy;

  /** A call that needs the account's signature and no balance: handy for trying the flow with an empty account. */
  async function prepareApproval() {
    if (!twin.address) return;
    setFormError(null);
    try {
      const { sequence } = await stellarServer().getLatestLedger();
      await action.prepare({
        kind: "invoke",
        contract: NETWORK.stellar.usdc,
        fn: "approve",
        args: parseArguments(
          [`address:${twin.address}`, `address:${NETWORK.stellar.hub}`, "i128:1", `u32:${sequence + 200}`].join("\n"),
        ),
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The network did not answer");
    }
  }

  return (
    <>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void action.prepare({ kind: "transfer", to, amount });
        }}
      >
        <h3>Send USDC</h3>
        <label>
          To{" "}
          <input style={field} size={62} value={to} placeholder="G…, C…, 0x… or name.eth" onChange={(event) => setTo(event.target.value)} />
        </label>{" "}
        <label>
          Amount{" "}
          <input style={field} size={10} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>{" "}
        <button type="submit" style={field} disabled={busy}>
          Review and sign
        </button>
      </form>

      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void action.prepare({ kind: "exit", recipient: exitTo, amount: exitAmount });
        }}
      >
        <h3>Send USDC back to Base</h3>
        <label>
          To (0x… or name.eth){" "}
          <input style={field} size={46} value={exitTo} onChange={(event) => setExitTo(event.target.value)} />
        </label>{" "}
        <label>
          Amount{" "}
          <input style={field} size={10} inputMode="decimal" value={exitAmount} onChange={(event) => setExitAmount(event.target.value)} />
        </label>{" "}
        <button type="submit" style={field} disabled={busy}>
          Review and sign
        </button>
      </form>

      <details>
        <summary>Call any contract</summary>
        <p>
          <button type="button" style={field} disabled={busy} onClick={() => void prepareApproval()}>
            Try it with an empty account: approve the hub for 0.0000001 USDC
          </button>
        </p>
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setFormError(null);
            try {
              void action.prepare({ kind: "invoke", contract: contract.trim(), fn: fn.trim(), args: parseArguments(args) });
            } catch (error) {
              setFormError(error instanceof Error ? error.message : "Check the arguments");
            }
          }}
        >
          <p>
            <label>
              Contract <input style={field} size={62} value={contract} onChange={(event) => setContract(event.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Function <input style={field} value={fn} onChange={(event) => setFn(event.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Arguments, one per line as type:value
              <br />
              <textarea
                style={field}
                rows={5}
                cols={72}
                value={args}
                placeholder={`address:${twin.address ?? "C…"}\naddress:${NETWORK.stellar.hub}\ni128:1\nu32:6000000`}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
          </p>
          <button type="submit" style={field} disabled={busy}>
            Review and sign
          </button>
        </form>
      </details>

      {action.phase === "preparing" ? <p role="status">Preparing…</p> : null}
      {formError ? <p role="alert">{formError}</p> : null}
    </>
  );
}

function Lines({ lines }: { lines: PanelLine[] }) {
  return (
    <table>
      <tbody>
        {lines.map((line, index) => (
          <tr key={line.id} data-differs={line.differs}>
            <th scope="row" style={{ textAlign: "left", paddingRight: 12, fontWeight: "normal" }}>
              {index > 0 && lines[index - 1]?.label === line.label ? "" : line.label}
            </th>
            <td>
              <code>{line.differs ? <mark>{line.value}</mark> : line.value}</code>
              {line.name ? ` ${line.name}` : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Review({ action }: { action: ActionFlow }) {
  const { state, panels } = action;
  const verdict = {
    none: "",
    unsigned: "Not signed yet",
    checking: "The contract is checking…",
    match: "MATCH",
    refused: "REFUSED",
  }[panels.verdict];

  return (
    <div>
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        <section aria-labelledby="wallet-shows">
          <h3 id="wallet-shows">Your wallet shows</h3>
          <Lines lines={panels.wallet} />
        </section>
        <section aria-labelledby="contract-verifies">
          <h3 id="contract-verifies">The contract verifies</h3>
          {panels.contract ? <Lines lines={panels.contract} /> : <p>Nothing has been submitted yet.</p>}
        </section>
      </div>

      <p role="status" data-verdict={panels.verdict}>
        <strong>{verdict}</strong>
        {state.phase === "done" ? (
          <>
            {" — "}signed by {shortAddress(state.owner)}.{" "}
            <a href={action.link ?? undefined} target="_blank" rel="noreferrer">
              {shortHash(state.hash)} ↗
            </a>
          </>
        ) : null}
        {state.phase === "refused" ? (
          <>
            {" — "}
            {state.reason}{" "}
            <small>
              (<code>{state.code}</code>)
            </small>
          </>
        ) : null}
      </p>
      {state.phase === "refused" ? (
        <details>
          <summary>What the relayer said</summary>
          <p>{state.detail}</p>
        </details>
      ) : null}

      {state.phase === "review" ? (
        <>
          {state.notice === "rejected" ? <p role="status">Declined in the wallet. Nothing was signed.</p> : null}
          <p>
            <label>
              <input type="checkbox" checked={action.tamper} onChange={(event) => action.setTamper(event.target.checked)} /> Change
              the amount after signing
            </label>
          </p>
          <button type="button" style={field} onClick={() => void action.sign()}>
            Sign and send
          </button>{" "}
          <button type="button" style={field} onClick={action.back}>
            Back
          </button>
        </>
      ) : null}
      {state.phase === "signing" ? <p role="status">Waiting for the signature…</p> : null}
      {state.phase === "relaying" ? <p role="status">Sending…</p> : null}
      {state.phase === "expired" ? (
        <p role="alert">
          The signature expired before it was used.{" "}
          <button type="button" style={field} onClick={() => void action.signAgain()}>
            Sign again
          </button>
        </p>
      ) : null}
      {state.phase === "failed" ? (
        <p role="alert">
          {state.error.message}{" "}
          <small>
            (<code>{state.error.code}</code>)
          </small>{" "}
          <button type="button" style={field} onClick={() => void action.prepare(state.request)}>
            Try again
          </button>
        </p>
      ) : null}
      {state.phase === "done" || state.phase === "refused" || state.phase === "expired" || state.phase === "failed" ? (
        <button type="button" style={field} onClick={action.reset}>
          New transaction
        </button>
      ) : null}
    </div>
  );
}

function ActivityList({ account }: { account: string | null }) {
  const activity = useActivity(account);
  const now = useNow("slow");
  return (
    <section aria-labelledby="activity">
      <h2 id="activity">Activity</h2>
      {activity.status === "loading" && activity.items.length === 0 ? <p role="status">Loading…</p> : null}
      {activity.error ? <p role="alert">Stellar did not answer: {activity.error} Showing what this browser remembers.</p> : null}
      {activity.isEmpty ? <p>Nothing yet. Stellar lists the last seven days.</p> : null}
      <ul>
        {activity.items.map((item) => (
          <li key={item.id} data-kind={item.kind} data-status={item.status}>
            {item.title}
            {now !== null ? ` · ${relativeTime(item.time, now)}` : null}
            {item.links.base ? (
              <>
                {" · "}
                <a href={item.links.base} target="_blank" rel="noreferrer">
                  Base ↗
                </a>
              </>
            ) : null}
            {item.links.stellar ? (
              <>
                {" · "}
                <a href={item.links.stellar} target="_blank" rel="noreferrer">
                  Stellar ↗
                </a>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
