"use client";

import Link from "next/link";
import { useState, type ChangeEvent, type ReactNode } from "react";

import { FarSide } from "@/components/art";

import { DEMO_ACCOUNT, DEMO_ADDRESS, shorten } from "./demo";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PARTIAL = /^0x[0-9a-fA-F]{0,39}$/;
const ENS_NAME = /^[^\s/]+\.eth$/i;

type Derived = { address: string; account: string | null };

let sdk: Promise<typeof import("@paso/sdk")> | undefined;
const loadSdk = () => (sdk ??= import("@paso/sdk"));

/** A Stellar address in two halves, so it breaks in the middle when there is room for that. */
function Account({ value }: { value: string }) {
  return (
    <span className="acct">
      <span>{value.slice(0, 28)}</span>
      <span>{value.slice(28)}</span>
    </span>
  );
}

export function AddressLookup({ children }: { children: ReactNode }) {
  const [input, setInput] = useState("");
  const [derived, setDerived] = useState<Derived | null>(null);
  const query = input.trim();
  const found = derived?.address === query ? derived : null;

  async function derive(event: ChangeEvent<HTMLInputElement>) {
    setInput(event.target.value);
    const address = event.target.value.trim();
    if (!ADDRESS.test(address)) return;
    try {
      const { twinAddress } = await loadSdk();
      setDerived({ address, account: twinAddress(address as `0x${string}`, "testnet") });
    } catch {
      setDerived({ address, account: null });
    }
  }

  let result: ReactNode;
  if (!query) {
    result = (
      <>
        <span className="label">For example, {shorten(DEMO_ADDRESS)} is</span>
        <Account value={DEMO_ACCOUNT} />
        <span className="note">
          <Link className="link" href={`/lookup/${DEMO_ADDRESS}`}>
            Open this account
          </Link>
        </span>
      </>
    );
  } else if (ENS_NAME.test(query)) {
    result = (
      <>
        <span className="label">Names are resolved on the lookup page.</span>
        <span className="note">
          <Link className="link" href={`/lookup/${encodeURIComponent(query)}`}>
            Look up {query}
          </Link>
        </span>
      </>
    );
  } else if (ADDRESS.test(query)) {
    if (found?.account) {
      result = (
        <>
          <span className="label">{shorten(query)} is</span>
          <Account value={found.account} />
          <span className="note">
            It can receive USDC now.{" "}
            <Link className="link" href={`/lookup/${query}`}>
              Open this account
            </Link>
          </span>
        </>
      );
    } else if (found) {
      result = <span className="label">That address does not check out. Copy it again from your wallet.</span>;
    } else {
      result = <span className="label">Working out its Stellar account…</span>;
    }
  } else if (PARTIAL.test(query)) {
    result = <span className="label">Keep going: an address is 0x and 40 characters. {40 - (query.length - 2)} to go.</span>;
  } else {
    result = <span className="label">That is neither an address nor an ENS name. Try 0x and 40 characters, or a name ending in .eth.</span>;
  }

  return (
    <>
      <div className="wrap">
        {children}
        <div className="right">
          <form className="lookup" onSubmit={(event) => event.preventDefault()}>
            <label className="vh" htmlFor="any-address">
              Ethereum address or ENS name
            </label>
            <input
              id="any-address"
              type="text"
              inputMode="text"
              placeholder="vitalik.eth or 0x…"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={input}
              onChange={derive}
              onFocus={() => void loadSdk()}
            />
          </form>
          <p className="result" aria-live="polite">
            {result}
          </p>
        </div>
      </div>
      <FarSide className="farside" id="any-far-side" account={found?.account ?? DEMO_ACCOUNT} />
    </>
  );
}
