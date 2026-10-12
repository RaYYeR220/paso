import type { Metadata } from "next";
import { AccountPair, AppShell, ExternalLink, TopBar } from "@/components/app";
import { NETWORK_LABEL, REFUSAL_ON_CHAIN, SITE_LINKS } from "@/components/app/site";
import { LiveStatus } from "./LiveStatus";

export const metadata: Metadata = {
  title: "Proof",
  description: "Every claim Paso makes, with the transaction or the command that backs it.",
};

const LINKS = SITE_LINKS.filter((link) => link.href !== "/proof");

const OWNER = "0x7880DA9a52Af491f76421869d4e28DC0A4D1767C";
const ACCOUNT = "CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME";
const HUB = "CBNSNERNVI7NW7JWDLOFJQJYMJC67EMVZLQONBBPWR4HLQMP53QGFOBO";
const ACCOUNT_CODE_HASH = "2ee1ac08ca6407667db15bcffe75c8cbb4e41d95b2d047541b5dad133cfe75ee";

const MAINNET_OWNER = "0x20806157d9607050204bbbCd37CE71498B35D46c";
const MAINNET_ACCOUNT = "CBWU43NDIBPC6SD2WKVNJH6A5ROHGMSDJWAVLCO3RITO5Q264XEZ7EPX";
const MAINNET_HUB = "CDZCHMNSAAIST5K2DNP4DP6H3DE4UJISUOMDFQTKD7IK6CD477AB7LJK";

const BASESCAN = "https://sepolia.basescan.org/tx/";
const EXPERT = "https://stellar.expert/explorer/testnet/";
const MAINNET_BASESCAN = "https://basescan.org/tx/";
const MAINNET_EXPERT = "https://stellar.expert/explorer/public/";
const TESTNET_REFUSAL = `${EXPERT}tx/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181`;
const REPO = "https://github.com/RaYYeR220/paso";

interface Station {
  text: string;
  chain: "Base" | "Base Sepolia" | "Stellar";
  href: string;
}

const MAINNET_RUN: readonly Station[] = [
  {
    text: "1 USDC burned on Base, attested by Circle in 2 seconds",
    chain: "Base",
    href: `${MAINNET_BASESCAN}0x460008a250884ff32698bd849f2094f2217c8b613a3ce3c5041a44730194994c`,
  },
  {
    text: "Delivered on Stellar into an account that was not deployed yet",
    chain: "Stellar",
    href: `${MAINNET_EXPERT}tx/a742bf77748cc1d2fb25347996dea79fa4e3827d7005cf6391588874a44fe1a0`,
  },
  {
    text: "0.1 USDC sent, signed with the Ethereum key",
    chain: "Stellar",
    href: `${MAINNET_EXPERT}tx/85cb7efa882a1cc6cc54c294bd7d60e5c7b6e47c8221ff7625fb44f6623e2322`,
  },
  {
    text: "0.5 USDC back to Base with one signature",
    chain: "Stellar",
    href: `${MAINNET_EXPERT}tx/fccc2318b8322cc020fd0d6c0a84f05dea45a36725ae9ba24f36a6a7287d76c6`,
  },
  {
    text: "Minted on Base 7 seconds later",
    chain: "Base",
    href: `${MAINNET_BASESCAN}0x5b713522befbbeeb702d9bb8d48e4fc13da7585b3222ec52e5e7296caf3e4776`,
  },
];

const RUN: readonly Station[] = [
  {
    text: "1 USDC burned on Base Sepolia",
    chain: "Base Sepolia",
    href: `${BASESCAN}0x43c00d27bf35c2288c160e6e1bfad424a206dc0e0b2d0ae901e7b20a88879b9e`,
  },
  {
    text: "Attested by Circle in 7 seconds, delivered on Stellar: 0.99987 USDC in the account",
    chain: "Stellar",
    href: `${EXPERT}tx/f7c95418993326f42b05c8a682e9dc3a9a7e18d0ad267b168eba09b1a40d23f1`,
  },
  {
    text: "0.1 USDC sent to the Stellar account of another Ethereum address that had never been deployed",
    chain: "Stellar",
    href: `${EXPERT}tx/dc3db1dd76496889c53a0007d3017e6b0d8019848c4ebbe555f9899b76eadf63`,
  },
  {
    text: "0.5 USDC sent back to Base with one signature",
    chain: "Stellar",
    href: `${EXPERT}tx/6cae28f1ea0f3d8020cfda61f75cfb6b8b13914fe859569d20c9e935a2e79a2f`,
  },
  {
    text: "Minted on Base Sepolia 9 seconds later",
    chain: "Base Sepolia",
    href: `${BASESCAN}0xd81b8b7e8f762910712494e3fba1b29144f2cef41a27081c44adb820ee5b137d`,
  },
];

const TESTS: readonly { text: string; command?: string }[] = [
  { text: "Account contract 29, hub 15", command: "pnpm test:contracts" },
  { text: "SDK 200 offline", command: "pnpm test:sdk" },
  { text: "Relayer and client 321 offline", command: "pnpm test:web" },
  { text: "11 signing vectors checked by both the Rust and the TypeScript suites." },
];

function Stations({ run }: { run: readonly Station[] }) {
  return (
    <ol className="stations">
      {run.map((station) => (
        <li key={station.href}>
          <span>{station.text}</span>
          <ExternalLink href={station.href}>{station.chain}</ExternalLink>
        </li>
      ))}
    </ol>
  );
}

/** Every claim, each with the transaction or the command that backs it. */
export default function ProofPage() {
  return (
    <AppShell>
      <TopBar network={NETWORK_LABEL} links={LINKS} />
      <AccountPair evmAddress={MAINNET_OWNER} stellarAddress={MAINNET_ACCOUNT} showBalance={false} />
      <main className="doc">
        <div className="doc-lead">
          <h1>Proof</h1>
          <p>Every claim Paso makes, with the transaction or the command that backs it.</p>
          <p className="doc-meta">Mainnet first: Stellar and Base. Then the testnet this site runs on: Stellar testnet and Base Sepolia.</p>
          <LiveStatus />
        </div>

        <div className="doc-body">
          <section aria-labelledby="mainnet">
            <h2 id="mainnet">On mainnet</h2>
            <p className="doc-meta">
              Real USDC, owner <span className="hash">{MAINNET_OWNER}</span>
            </p>
            <Stations run={MAINNET_RUN} />
            <ul className="claims">
              <li data-mark="refused">
                <span>Signed for amount 1, submitted with 10000000000000: refused on mainnet, Error(Contract, #2)</span>
                <ExternalLink href={REFUSAL_ON_CHAIN}>Stellar</ExternalLink>
              </li>
            </ul>
            <dl className="facts">
              <div>
                <dt>Hub on mainnet</dt>
                <dd className="hash">
                  <ExternalLink href={`${MAINNET_EXPERT}contract/${MAINNET_HUB}`}>{MAINNET_HUB}</ExternalLink>
                </dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd className="hash">{MAINNET_ACCOUNT}</dd>
              </div>
              <div>
                <dt>Account code hash</dt>
                <dd className="hash">{ACCOUNT_CODE_HASH}, the same as on testnet</dd>
              </div>
            </dl>
            <p>The mainnet run was made with the project&rsquo;s scripts. This site and its relayer run on testnet.</p>
          </section>

          <section aria-labelledby="run">
            <h2 id="run">One run, start to finish</h2>
            <p className="doc-meta">
              Testnet, 2026-10-12, owner <span className="hash">{OWNER}</span>
            </p>
            <Stations run={RUN} />
            <p className="doc-sum">
              From the burn on Base to the mint back on Base: 32 seconds. The owner&rsquo;s account paid no Stellar fee.
            </p>
          </section>

          <section aria-labelledby="refusal">
            <h2 id="refusal">The refusal, on testnet</h2>
            <ul className="claims">
              <li data-mark="refused">
                <span>
                  Signed for amount 1, submitted with amount 10000000000000: FAILED on chain, account answered
                  Error(Contract, #2) BadSignature
                </span>
                <ExternalLink href={TESTNET_REFUSAL}>Stellar</ExternalLink>
              </li>
              <li data-mark="match">
                <span>The honest twin of that call, accepted</span>
                <ExternalLink href={`${EXPERT}tx/b8a81489a2b20babc3ceadf6c9b22ba15965c725a6594b3413de6c4aadc91ac5`}>
                  Stellar
                </ExternalLink>
              </li>
            </ul>
          </section>

          <section aria-labelledby="contracts">
            <h2 id="contracts">Contracts</h2>
            <p className="doc-meta">Stellar testnet</p>
            <dl className="facts">
              <div>
                <dt>Hub</dt>
                <dd className="hash">
                  <ExternalLink href={`${EXPERT}contract/${HUB}`}>{HUB}</ExternalLink>
                </dd>
              </div>
              <div>
                <dt>Example account</dt>
                <dd className="hash">
                  <ExternalLink href={`${EXPERT}contract/${ACCOUNT}`}>{ACCOUNT}</ExternalLink>
                </dd>
              </div>
              <div>
                <dt>Account code hash</dt>
                <dd className="hash">{ACCOUNT_CODE_HASH}</dd>
              </div>
            </dl>
            <p>Account code 7,837 bytes; hub 4,156 bytes. No admin key, no upgrade path.</p>
          </section>

          <section aria-labelledby="tests">
            <h2 id="tests">Tests</h2>
            <ul className="claims">
              {TESTS.map((test) => (
                <li key={test.text}>
                  <span>{test.text}</span>
                  {test.command ? <code>{test.command}</code> : null}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="check">
            <h2 id="check">Check it yourself</h2>
            <p>
              <code>pnpm verify 43a92797a315f742ef121ec607e9d2ca23b68e10eb6d2ce931f5e7f7f0ad6d90</code>
            </p>
            <p>
              Rebuilds the signed message from the transaction, recovers the signer and checks it is the account&rsquo;s
              owner.
            </p>
            <p className="doc-links">
              <ExternalLink href={`${REPO}/blob/main/docs/VERIFY.md`}>Guide</ExternalLink>
              <ExternalLink href={`${REPO}/blob/main/docs/CLAIMS.md`}>Every claim and its status</ExternalLink>
              <ExternalLink href={REPO}>Source</ExternalLink>
            </p>
          </section>

          <section aria-labelledby="limits">
            <h2 id="limits">Limits</h2>
            <p>
              No key rotation or recovery. Regular wallets only, not smart-contract wallets. Vectors, maps and structs in
              arguments are bound by hash rather than shown as text. The relayer can decline to relay; it cannot move
              funds, and anyone can submit instead. Unaudited.
            </p>
          </section>
        </div>
      </main>
    </AppShell>
  );
}
