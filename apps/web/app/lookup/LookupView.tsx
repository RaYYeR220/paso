"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { AccountPair, AppShell, Chrome, Notice, Skeleton } from "@/components/app";
import { useLookup, useNetworkChoice, useOwnerKind } from "@/lib/client";

/** The Stellar account of any Ethereum address or ENS name, deployed or not, on the network the page is on. */
export function LookupView({ initial }: { initial: string }) {
  const id = useId();
  const router = useRouter();
  const choice = useNetworkChoice();
  const { network } = choice;
  const [input, setInput] = useState(initial);
  const lookup = useLookup(choice.ready ? input : "", network);
  const { twin } = lookup;
  const found = lookup.owner !== null && twin.address !== null;
  const kind = useOwnerKind(found ? lookup.owner : null);
  const unread = twin.status === "error";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = input.trim();
    if (typed) router.replace(choice.href(`/lookup/${encodeURIComponent(typed)}`));
  };

  return (
    <AppShell>
      <Chrome choice={choice} current="/lookup" />
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
          <p className="doc-meta">
            Only a regular wallet can ever spend from its account. The account of a smart-contract address receives and
            cannot send.
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
                    <dt>Stellar {network}</dt>
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
                    <dt>Owner</dt>
                    <dd>
                      {kind === "checking" || kind === null ? (
                        <Skeleton width="11em" />
                      ) : kind === "wallet" ? (
                        "no contract code found: a regular wallet, or a smart wallet not deployed yet"
                      ) : kind === "contract" ? (
                        "a smart contract"
                      ) : (
                        "could not be checked"
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
                <p className="doc-meta">
                  This is the address on Stellar {network}. On {network === "mainnet" ? "testnet" : "mainnet"} the same owner has
                  another one.
                </p>
                {unread && twin.error ? <Notice>Stellar did not answer: {twin.error}</Notice> : null}
                {kind === "contract" ? (
                  <Notice>
                    This address is a smart contract. It has no key, so its Stellar account could never move what you send.
                    Do not send USDC to it.
                  </Notice>
                ) : (
                  <>
                    {kind === "unknown" ? (
                      <Notice tone="note">
                        It could not be checked whether this address is a regular wallet or a smart contract. Only send to an
                        address you know is a regular wallet.
                      </Notice>
                    ) : null}
                    <Link className="btn btn-inline" href={choice.href(`/app?to=${encodeURIComponent(lookup.name ?? lookup.owner ?? "")}`)}>
                      Send USDC to it
                    </Link>
                  </>
                )}
              </>
            ) : null}
          </div>
        </div>
      </main>
    </AppShell>
  );
}
