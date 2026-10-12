import Link from "next/link";

import { palette } from "@/components/art";

import { Crest } from "./Crest";
import { REPO_URL, VERIFY_URL } from "./demo";

const FACTS = [
  { name: "Account contract", detail: "7.8 KB, 29 tests" },
  { name: "Hub", detail: "4.2 KB, 15 tests" },
  { name: "SDK", detail: "189 tests, sharing 11 signing vectors with the contracts" },
  { name: "Base Sepolia → Stellar", detail: "in 7 seconds, and back in 9" },
] as const;

export function Proof() {
  return (
    <section className="band proof" id="proof" aria-labelledby="proof-title">
      <Crest id="proof-crest" fill={palette.mustard} seed={13} offset={6} />
      <div className="wrap">
        <div className="lede">
          <h2 className="h2" id="proof-title">
            Two small contracts. No admin keys.
          </h2>
          <p className="links">
            <a className="link" href={REPO_URL}>
              Read the contracts
            </a>
            <a className="link" href={VERIFY_URL}>
              Verify a transaction yourself
            </a>
            <Link className="link" href="/proof">
              See every claim
            </Link>
          </p>
          <h3 className="vh">Limits</h3>
          <p className="limits">No key rotation yet. Regular wallets only, not smart-contract wallets. Unaudited.</p>
        </div>
        <ul className="post">
          {FACTS.map((fact) => (
            <li key={fact.name} className="board">
              <b>{fact.name}</b>
              <span>{fact.detail}</span>
            </li>
          ))}
          <li className="board live">
            <b>Live on Stellar testnet</b>
          </li>
        </ul>
      </div>
    </section>
  );
}
