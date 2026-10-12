"use client";

import { NETWORK, baseAddress, stellarAddress, useHealth } from "@/lib/client";

/** What is deployed and what the server runs on, each with a link to check it. */
export default function ProofPage() {
  const health = useHealth();
  const { report } = health;
  const { hub, accountWasmHash, usdc, forwarder, tokenMessenger, messageTransmitter } = NETWORK.stellar;
  const contracts: [string, string][] = [
    ["Hub", report?.hub || hub],
    ["USDC", usdc],
    ["Circle forwarder", forwarder],
    ["Circle TokenMessenger", tokenMessenger],
    ["Circle MessageTransmitter", messageTransmitter],
  ];

  return (
    <main style={{ padding: 16 }}>
      <h1>Paso</h1>
      <h2>Proof</h2>

      <h3>Contracts on Stellar {NETWORK.name}</h3>
      <ul>
        {contracts.map(([name, address]) =>
          address ? (
            <li key={name}>
              {name}:{" "}
              <a href={stellarAddress(address)} target="_blank" rel="noreferrer">
                <code>{address}</code>
              </a>
            </li>
          ) : null,
        )}
        <li>
          Account contract (wasm hash): <code>{accountWasmHash || "not deployed"}</code>
        </li>
      </ul>

      <h3>Server</h3>
      {health.status === "loading" || health.status === "idle" ? <p role="status">Loading…</p> : null}
      {health.error ? <p role="alert">The server did not answer: {health.error}</p> : null}
      {report ? (
        <ul>
          <li>
            Healthy: <code>{String(report.ok)}</code>
          </li>
          <li>
            Network: <code>{report.network}</code>
          </li>
          <li>
            Latest ledger: <code>{report.latestLedger ?? "unknown"}</code>
          </li>
          <li>
            Relayer (pays fees, nothing else):{" "}
            <a href={stellarAddress(report.relayer.address)} target="_blank" rel="noreferrer">
              <code>{report.relayer.address}</code>
            </a>{" "}
            · {report.relayer.xlm ?? "unknown"} XLM
          </li>
          <li>
            Most a relayed call may cost: <code>{report.maxResourceFee}</code> stroops
          </li>
          {report.payer ? (
            <li>
              Faucet payer on {report.payer.chain}:{" "}
              <a href={baseAddress(report.payer.address)} target="_blank" rel="noreferrer">
                <code>{report.payer.address}</code>
              </a>{" "}
              · {report.payer.usdc ?? "unknown"} USDC · {report.payer.eth ?? "unknown"} ETH · faucet {health.faucet}
            </li>
          ) : (
            <li>Faucet: switched off</li>
          )}
        </ul>
      ) : null}
    </main>
  );
}
