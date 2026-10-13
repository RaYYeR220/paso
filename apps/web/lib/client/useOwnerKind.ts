"use client";

import type { OwnerKind } from "paso-sdk";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { checkOwner } from "./ownerCheck";

/**
 * Whether an Ethereum address is a wallet with a key or a smart contract, as
 * far as the code at the address shows: `checking` until the chains have
 * answered, `null` when there is no address to ask about.
 */
export function useOwnerKind(address: Address | null | undefined): OwnerKind | "checking" | null {
  const [answer, setAnswer] = useState<{ address: Address; kind: OwnerKind } | null>(null);

  useEffect(() => {
    if (!address) return;
    let current = true;
    void checkOwner(address).then((check) => {
      if (current) setAnswer({ address, kind: check.kind });
    });
    return () => {
      current = false;
    };
  }, [address]);

  if (!address) return null;
  return answer?.address === address ? answer.kind : "checking";
}
