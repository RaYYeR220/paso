import type { Metadata } from "next";
import { Suspense } from "react";
import { decodeParam } from "@/lib/client/parse";
import { LookupFallback } from "../LookupFallback";
import { LookupView } from "../LookupView";

export const metadata: Metadata = {
  title: "Look up an address",
  description: "The Stellar account of an Ethereum address or ENS name: deployed or not, and what it holds.",
};

async function Resolved({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <LookupView key={address} initial={decodeParam(address)} />;
}

/** `/lookup/0x…` or `/lookup/vitalik.eth`. */
export default function LookupPage({ params }: PageProps<"/lookup/[address]">) {
  return (
    <Suspense fallback={<LookupFallback />}>
      <Resolved params={params} />
    </Suspense>
  );
}
