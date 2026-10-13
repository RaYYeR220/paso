"use client";

import { useId, type FormEvent, type ReactNode } from "react";
import { ChainChoice, type ChainChoiceOption } from "./ChainChoice";
import { Tracker, type TrackerProps } from "./Tracker";

export interface FundPanelProps {
  /** A wallet burns its own USDC on the chain chosen; the demo key asks the testnet faucet on Base Sepolia. */
  mode: "wallet" | "demo";
  /** The chain the USDC leaves, by the name it has on every network: "Base", "Arbitrum", "Arc". */
  chain: string;
  /** Every chain it can leave from, Base first. */
  chains: readonly ChainChoiceOption[];
  /** The chosen chain's name in the SDK. */
  chainName: string;
  onChainChange?: (name: string) => void;
  /** True while a transfer is on its way: the chain it left cannot be changed. */
  chainLocked?: boolean;
  /** One line under the chips: what the wallet holds there, or why the other chains are not offered. */
  chainNote?: ReactNode;
  /** Decimal text, as typed. */
  amount: string;
  onAmountChange?: (value: string) => void;
  /** True while a transfer is being requested or followed. */
  busy: boolean;
  /** Stops the form without a transfer running: no signer yet, or a problem to resolve first. */
  disabled?: boolean;
  onSubmit: () => void;
  /**
   * Set while a wallet has yet to show that it signs with its own key. The
   * amount is not asked for before: the panel offers the check instead.
   */
  keyCheck?: { asking: boolean; onCheck: () => void };
  stages: TrackerProps["stages"];
  progress?: number;
  /** One line under the amount: what the wallet is being asked, a problem, a way to retry. */
  status?: ReactNode;
}

export function FundPanel({
  mode,
  chain,
  chains,
  chainName,
  onChainChange,
  chainLocked = false,
  chainNote,
  amount,
  onAmountChange,
  busy,
  disabled,
  onSubmit,
  keyCheck,
  stages,
  progress,
  status,
}: FundPanelProps) {
  const id = useId();
  const fixed = mode === "demo";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && !disabled) onSubmit();
  };

  return (
    <section className="fund" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Bring USDC from {chain}</h2>
      <ChainChoice
        legend="Bring USDC from"
        options={chains}
        value={chainName}
        onChange={(name) => onChainChange?.(name)}
        disabled={chainLocked || busy}
        note={keyCheck ? undefined : chainNote}
      />
      {keyCheck ? (
        <div className="fund-check">
          <p>
            First, one signature that moves nothing. It shows this wallet signs with its own key. A smart-contract wallet
            has none, and what its Stellar account received could never be moved.
          </p>
          <button className="btn btn-inline" type="button" disabled={keyCheck.asking || disabled} onClick={keyCheck.onCheck}>
            {keyCheck.asking ? "Sign in the wallet" : "Check this wallet"}
          </button>
        </div>
      ) : (
        <form className="fund-form" onSubmit={submit} noValidate>
          <label className="field-row" htmlFor={`${id}-amount`}>
            <span>Amount</span>
            <span className="field" data-fixed={fixed || undefined}>
              <input
                id={`${id}-amount`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                readOnly={fixed}
                disabled={busy || disabled}
                aria-describedby={`${id}-status`}
                onChange={(event) => onAmountChange?.(event.target.value)}
              />
              <em>USDC</em>
            </span>
          </label>
          <button className="btn btn-inline" type="submit" disabled={busy || disabled}>
            {busy ? "On its way" : fixed ? "Get test USDC" : "Bring over"}
          </button>
        </form>
      )}
      <div className="hint" id={`${id}-status`}>
        {status ?? (fixed ? `The testnet faucet burns this much on ${chain} for you.` : `One transaction on ${chain}, about 20 seconds.`)}
      </div>
      <Tracker stages={stages} progress={progress} />
    </section>
  );
}
