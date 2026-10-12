import Link from "next/link";

import { PassScene } from "@/components/art";

import { DEMO_ACCOUNT, DEMO_ADDRESS } from "./demo";
import { PointerDrift } from "./PointerDrift";

export function Hero() {
  return (
    <PointerDrift className="poster">
      <Link className="mark" href="/" aria-label="Paso, home">
        Paso
      </Link>
      <PassScene className="scene" id="hero" address={DEMO_ADDRESS} account={DEMO_ACCOUNT} />
      <div className="slab">
        <h1 className="claim">
          Your Ethereum <br />
          wallet is already <br />a Stellar account.
        </h1>
        <div className="side">
          <p className="sub">
            Same key. No new wallet, no seed phrase, no XLM. Bring USDC from Base in about 20 seconds, and sign exactly what you see.
          </p>
          <div className="cta">
            <Link className="btn" href="/app">
              Connect wallet
            </Link>
            <Link className="link" href="/app?demo=1">
              Try it without a wallet
            </Link>
          </div>
        </div>
        <p className="route">
          <span className="vh">An Ethereum address and the Stellar account it already has: </span>
          <span className="from">{DEMO_ADDRESS}</span>
          <span className="road" aria-hidden="true" />
          <span className="vh"> is </span>
          <span className="to">
            {DEMO_ACCOUNT.slice(0, 28)}
            <wbr />
            {DEMO_ACCOUNT.slice(28)}
          </span>
        </p>
      </div>
    </PointerDrift>
  );
}
