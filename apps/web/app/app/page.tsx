import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountPair, AppShell, TopBar } from "@/components/app";
import { NETWORK_LABEL } from "@/components/app/site";
import { AppScreen } from "./AppScreen";

export const metadata: Metadata = {
  title: "Account",
  description: "Bring USDC from Base, send it on Stellar, and watch the account contract check every signature.",
};

/** The sheet before the browser has said who is connected. */
function BlankScreen() {
  return (
    <AppShell layout="screen">
      <TopBar network={NETWORK_LABEL} />
      <AccountPair />
    </AppShell>
  );
}

export default function AppPage() {
  return (
    <Suspense fallback={<BlankScreen />}>
      <AppScreen />
    </Suspense>
  );
}
