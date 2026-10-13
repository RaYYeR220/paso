import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountPair, AppShell, TopBar } from "@/components/app";
import { AppScreen } from "./AppScreen";

export const metadata: Metadata = {
  title: "Account",
  description:
    "Bring USDC from Base, Ethereum, Arbitrum, OP Mainnet or Arc, send it on Stellar, and watch the account contract check every signature.",
};

/** The sheet before the browser has said which network it is on and who is connected. */
function BlankScreen() {
  return (
    <AppShell layout="screen">
      <div className="top">
        <TopBar />
      </div>
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
