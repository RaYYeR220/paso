"use client";

import { Chrome } from "@/components/app";
import { useNetworkChoice } from "@/lib/client";

/** The top of the proof page. The page itself shows both networks; the bar keeps the choice for the pages it links to. */
export function ProofChrome() {
  return <Chrome choice={useNetworkChoice()} current="/proof" />;
}
