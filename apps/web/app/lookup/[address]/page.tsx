"use client";

import { useParams, useRouter } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { decodeParam, useLookup } from "@/lib/client";

/** The Stellar account of any Ethereum address or ENS name: `/lookup/0x…`, `/lookup/vitalik.eth`. */
export default function LookupPage() {
  return (
    <main style={{ padding: 16 }}>
      <h1>Paso</h1>
      {/* The address in the URL is only known per request, so everything that reads it waits behind this boundary. */}
      <Suspense fallback={<p>Loading…</p>}>
        <LookupView />
      </Suspense>
    </main>
  );
}

function LookupView() {
  const { address } = useParams<{ address: string }>();
  const initial = decodeParam(address);
  const router = useRouter();
  const [input, setInput] = useState(initial);
  const lookup = useLookup(input);
  const { twin } = lookup;

  return (
    <section aria-labelledby="lookup">
      <h2 id="lookup">Every Ethereum address already has one.</h2>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (input.trim()) router.replace(`/lookup/${encodeURIComponent(input.trim())}`);
        }}
      >
        <label>
          Ethereum address or ENS name{" "}
          <input
            style={{ border: "1px solid", padding: "2px 6px" }}
            size={50}
            value={input}
            placeholder="vitalik.eth or 0x…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
      </form>

      <p role="status">
        status: <code>{lookup.status}</code>
        {lookup.status === "resolving" ? " — looking the name up…" : null}
      </p>
      {lookup.error ? <p role="alert">{lookup.error}</p> : null}

      {lookup.owner && twin.address ? (
        <dl>
          {lookup.name ? (
            <>
              <dt>Name</dt>
              <dd>{lookup.name}</dd>
            </>
          ) : null}
          <dt>Ethereum</dt>
          <dd>
            <a href={lookup.ownerLink ?? undefined} target="_blank" rel="noreferrer">
              <code>{lookup.owner}</code>
            </a>
          </dd>
          <dt>Stellar</dt>
          <dd>
            <a href={twin.link ?? undefined} target="_blank" rel="noreferrer">
              <code>{twin.address}</code>
            </a>
          </dd>
          <dt>Status</dt>
          <dd>
            {twin.deployed === null
              ? twin.status === "error"
                ? "could not be read"
                : "…"
              : twin.deployed
                ? "deployed"
                : "not deployed yet · can already receive"}
          </dd>
          <dt>Balance</dt>
          <dd>{twin.balanceFormatted === null ? (twin.status === "error" ? "could not be read" : "…") : `${twin.balanceFormatted} USDC`}</dd>
        </dl>
      ) : null}
      {lookup.owner && twin.error && twin.address ? <p role="alert">Stellar did not answer: {twin.error}</p> : null}
    </section>
  );
}
