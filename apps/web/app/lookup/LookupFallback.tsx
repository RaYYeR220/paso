import { AccountPair, AppShell, TopBar } from "@/components/app";

/** The lookup page before the browser has said which network it is on. */
export function LookupFallback() {
  return (
    <AppShell>
      <div className="top">
        <TopBar />
      </div>
      <AccountPair />
      <main className="doc">
        <div className="doc-lead">
          <h1>Every Ethereum address already has one.</h1>
        </div>
      </main>
    </AppShell>
  );
}
