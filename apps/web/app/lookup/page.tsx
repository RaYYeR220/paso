import type { Metadata } from "next";
import { LookupView } from "./LookupView";

export const metadata: Metadata = {
  title: "Look up an address",
  description: "Paste any Ethereum address or ENS name to see its Stellar account.",
};

export default function LookupIndexPage() {
  return <LookupView initial="" />;
}
