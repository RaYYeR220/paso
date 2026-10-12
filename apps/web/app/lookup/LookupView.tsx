"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { AccountPair, AppShell, Notice, Skeleton, TopBar } from "@/components/app";
import { NETWORK_LABEL, SITE_LINKS } from "@/components/app/site";
import { useLookup } from "@/lib/client";

const LINKS = SITE_LINKS.filter((link) => link.href !== "/lookup");

/** The Stellar account of any Ethereum address or ENS name, deployed or not. */
export function LookupView({ initial }: { initial: string }) {
  const id = useId();
  const router = useRouter();
  const [input, setInput] = useState(initial);
  const lookup = useLookup(input);
  const { twin } = lookup;
  const found = lookup.owner !== null && twin.address !== null;
  const unread = twin.status === "error";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = input.trim();
    if (typed) router.replace(`/lookup/${encodeURIComponent(typed)}`);
  };

  return (
    <AppShell>
      <TopBar network={NETWORK_LABEL} links={LINKS} />
      <AccountPair
        evmAddress={lookup.owner ?? undefined}
        stellarAddress={twin.address ?? undefined}
        balance={found ? (twin.balanceFormatted ?? (unread ? "unknown" : undefined)) : undefined}
        deployed={twin.deployed ?? undefined}
        evmHref={lookup.ownerLink ?? undefined}
        stellarHref={twin.link ?? undefined}
      />
      <main className="doc">
        <div className="doc-lead">
          <h1>Every Ethereum address already has one.</h1>
          <p>
            Paste any address or ENS name to see its Stellar account. You can pay it before its owner has ever heard of
            Stellar.
          </p>
        </div>
        <div className="doc-body">
          <form className="lookup-form" onSubmit={submit}>
            <label className="vh" htmlFor={`${id}-input`}>
              Ethereum address or ENS name
            </label>
            <span className="field" data-invalid={lookup.status === "invalid" ? true : undefined}>
              <input
                id={`${id}-input`}
                type="text"
                value={input}
                placeholder="vitalik.eth or 0x…"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby={`${id}-status`}
                onChange={(event) => setInput(event.target.value)}
              />
            </span>
            <button type="submit" className="btn btn-inline">
              Look it up
            </button>
          </form>

          <div className="lookup-result" id={`${id}-status`} aria-live="polite">
            {lookup.status === "empty" ? <p className="doc-meta">Nothing typed yet.</p> : null}
            {lookup.status === "resolving" ? <p className="doc-meta">Looking the name up on Ethereum.</p> : null}
            {lookup.status === "not_found" ? <Notice tone="note">That name is valid and points to no address.</Notice> : null}
            {(lookup.status === "invalid" || lookup.status === "error") && lookup.error ? <Notice>{lookup.error}</Notice> : null}

            {found ? (
              <>
                <dl className="facts">
                  {lookup.name ? (
                    <div>
                      <dt>Name</dt>
                      <dd>{lookup.name}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Ethereum</dt>
                    <dd className="hash">{lookup.owner}</dd>
                  </div>
                  <div>
                    <dt>Stellar</dt>
                    <dd className="hash">{twin.address}</dd>
                  </div>
                  <div>
                    <dt>Account</dt>
                    <dd>
                      {twin.deployed === null ? (
                        unread ? (
                          "could not be read"
                        ) : (
                          <Skeleton width="9em" />
                        )
                      ) : twin.deployed ? (
                        "deployed"
                      ) : (
                        "not deployed yet, can already receive"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Balance</dt>
                    <dd>
                      {twin.balanceFormatted === null ? (
                        unread ? (
                          "could not be read"
                        ) : (
                          <Skeleton width="5em" />
                        )
                      ) : (
                        `${twin.balanceFormatted} USDC`
                      )}
                    </dd>
                  </div>
                </dl>
                {unread && twin.error ? <Notice>Stellar did not answer: {twin.error}</Notice> : null}
                <Link className="btn btn-inline" href={`/app?to=${encodeURIComponent(lookup.name ?? lookup.owner ?? "")}`}>
                  Send USDC to it
                </Link>
              </>
            ) : null}
          </div>
        </div>
      </main>
    </AppShell>
  );
}
