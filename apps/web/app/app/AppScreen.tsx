"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AccountPair, AppShell, Chrome, Notice, SignerChooser } from "@/components/app";
import { shortAddress, useHealth, useNetworkChoice, useNow, useOwnerKind, useSigner } from "@/lib/client";
import { Workspace } from "./Workspace";

/**
 * The account screen, on the network the page is on. Until a key is chosen it
 * asks which one; on testnet `?demo=1` answers that question with the
 * throwaway key, once. On mainnet only a wallet will do.
 */
export function AppScreen() {
  const params = useSearchParams();
  const choice = useNetworkChoice();
  const { network } = choice;
  const signer = useSigner(network);
  const health = useHealth();
  const inBrowser = useNow("slow") !== null && choice.ready;
  const connected = signer.status === "connected" && signer.address !== null;
  // The demo key is a key by construction. A wallet's address is looked at: a smart contract cannot sign for an account.
  const walletKind = useOwnerKind(connected && !signer.isDemo ? signer.address : null);

  const report = health.of(network);
  // Until the server has said, testnet is taken to mint on Base Sepolia and mainnet not to, as each is set up by default.
  const paysBaseMints = report ? report.enabled && report.paysBaseMints : network === "testnet";

  const wantsDemo = params.get("demo") === "1" && signer.demo.available;
  const prefill = params.get("to") ?? "";
  const startDemo = signer.demo.connect;
  const [left, setLeft] = useState(false);
  const demoPending = wantsDemo && inBrowser && !left && signer.status === "disconnected";
  useEffect(() => {
    if (demoPending) void startDemo();
  }, [demoPending, startDemo]);

  if (inBrowser && connected && signer.address) {
    const chrome = (
      <Chrome
        choice={choice}
        current="/app"
        signer={shortAddress(signer.address)}
        signerKind={signer.isDemo ? "demo" : "wallet"}
        leaveLabel={signer.isDemo ? "Leave" : "Disconnect"}
        onLeave={() => {
          setLeft(true);
          void signer.disconnect();
        }}
      />
    );
    if (walletKind === "contract") {
      return (
        <AppShell layout="screen">
          {chrome}
          <AccountPair evmAddress={signer.address} showBalance={false} />
          <section className="chooser" aria-labelledby="contract-h">
            <div className="chooser-lead">
              <h1 id="contract-h">This wallet cannot sign for a Stellar account.</h1>
              <p>
                {shortAddress(signer.address)} is a smart contract. A Paso account obeys one thing, a signature made by the
                private key of its Ethereum address, and a smart-contract wallet has no such key. What its Stellar account
                received could never be moved.
              </p>
              <p>Connect a regular wallet instead: MetaMask, Rabby, the Coinbase Wallet extension or a Ledger.</p>
              <button type="button" className="btn btn-inline" onClick={() => void signer.disconnect()}>
                Disconnect this wallet
              </button>
            </div>
          </section>
        </AppShell>
      );
    }
    return (
      <AppShell layout="screen">
        {chrome}
        <Workspace
          key={`${network}:${signer.address}`}
          network={network}
          signer={signer}
          owner={signer.address}
          prefillTo={prefill}
          relayer={health.relayer(network)}
          paysBaseMints={paysBaseMints}
          proofHref={choice.href("/proof#mainnet")}
        />
      </AppShell>
    );
  }

  const restoring = !inBrowser || demoPending || (signer.status === "connecting" && signer.connectingId === null);
  return (
    <AppShell layout="screen">
      <Chrome choice={choice} current="/app" />
      <AccountPair />
      {restoring ? null : (
        <SignerChooser
          network={network}
          wallets={signer.connectors}
          onConnect={(id) => void signer.connect(id)}
          connectingId={signer.connectingId ?? undefined}
          onTryWithoutWallet={() => void signer.demo.connect()}
          onUseTestnet={() => choice.choose("testnet")}
          status={
            signer.error ? (
              <Notice actionLabel="Dismiss" onAction={signer.clearError}>
                {signer.error}
              </Notice>
            ) : null
          }
        />
      )}
    </AppShell>
  );
}
