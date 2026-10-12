"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AccountPair, AppShell, Notice, SignerChooser, TopBar } from "@/components/app";
import { NETWORK_LABEL, SITE_LINKS } from "@/components/app/site";
import { shortAddress, useNow, useSigner } from "@/lib/client";
import { Workspace } from "./Workspace";

const LINKS = SITE_LINKS.filter((link) => link.href !== "/app");

/**
 * The account screen. Until a key is chosen it asks which one; `?demo=1`
 * answers that question with the throwaway key, once.
 */
export function AppScreen() {
  const params = useSearchParams();
  const signer = useSigner();
  const inBrowser = useNow("slow") !== null;
  const connected = signer.status === "connected" && signer.address !== null;

  const wantsDemo = params.get("demo") === "1";
  const prefill = params.get("to") ?? "";
  const startDemo = signer.demo.connect;
  const [left, setLeft] = useState(false);
  const demoPending = wantsDemo && inBrowser && !left && signer.status === "disconnected";
  useEffect(() => {
    if (demoPending) void startDemo();
  }, [demoPending, startDemo]);

  if (connected && signer.address) {
    return (
      <AppShell layout="screen">
        <TopBar
          network={NETWORK_LABEL}
          signer={shortAddress(signer.address)}
          signerKind={signer.isDemo ? "demo" : "wallet"}
          leaveLabel={signer.isDemo ? "Leave" : "Disconnect"}
          onLeave={() => {
            setLeft(true);
            void signer.disconnect();
          }}
          links={LINKS}
        />
        <Workspace key={signer.address} signer={signer} owner={signer.address} prefillTo={prefill} />
      </AppShell>
    );
  }

  const restoring = !inBrowser || demoPending || (signer.status === "connecting" && signer.connectingId === null);
  return (
    <AppShell layout="screen">
      <TopBar network={NETWORK_LABEL} links={LINKS} />
      <AccountPair />
      {restoring ? null : (
        <SignerChooser
          wallets={signer.connectors}
          onConnect={(id) => void signer.connect(id)}
          connectingId={signer.connectingId ?? undefined}
          onTryWithoutWallet={() => void signer.demo.connect()}
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
