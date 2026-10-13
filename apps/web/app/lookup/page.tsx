import type { Metadata } from "next";
import { Suspense } from "react";
import { LookupFallback } from "./LookupFallback";
import { LookupView } from "./LookupView";

export const metadata: Metadata = {
  title: "Look up an address",
  description: "Paste any Ethereum address or ENS name to see its Stellar account.",
};

export default function LookupIndexPage() {
  return (
    <Suspense fallback={<LookupFallback />}>
      <LookupView initial="" />
    </Suspense>
  );
}
