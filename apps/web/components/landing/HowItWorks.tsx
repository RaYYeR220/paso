import {
  farRidge,
  HandCutFilter,
  KilometreStone,
  landPath,
  mix,
  palette,
  Peak,
  Road,
  Sun,
  Tree,
  type PeakShape,
} from "@/components/art";

import { bytes, crestLine, digits, groundOn, NARROW_STONE, narrowRoad, RISE, STAGES, STRIP, wideRoad, type Stage } from "./terrain";

const HEADROOM = 80;
const DEPTH = 1600;
const RIGHT = STRIP.left + STRIP.width;

const GROUND = { 1: palette.terracottaGround, 2: palette.mustard, 3: palette.tealDeep } as const;
const CAP = { 1: palette.mustard, 2: palette.terracotta, 3: palette.mustard } as const;

const TREES = [
  [-648, 0.82],
  [-576, 0.56],
  [-288, 0.7],
  [-43, 0.52],
  [576, 0.86],
  [648, 0.6],
] as const;

/** The range just crossed, small and behind: one peak per address byte, again. */
function RangeBehind() {
  const base = RISE * 1.4;
  const peaks: PeakShape[] = Array.from({ length: 20 }, (_, i) => {
    const byte = bytes[(i * 7 + 3) % 20];
    return {
      x: STRIP.left + (i + 0.5) * 150 + ((byte & 15) - 7.5) * 5,
      y: 4 + Math.pow(1 - byte / 255, 1.2) * RISE * 0.62,
      leftSlope: 1 + ((byte >> 2) & 3) * 0.16,
      rightSlope: 1.3 + ((byte >> 4) & 3) * 0.2,
      bits: byte,
    };
  }).sort((a, b) => a.y - b.y);

  return peaks.map((peak, i) => (
    <Peak
      key={i}
      id={`behind-${i}`}
      base={base}
      tone={mix(palette.terracottaLight, palette.terracotta, Math.min(1, i / 6))}
      snow={peak.y < RISE * 0.3 ? RISE * 0.16 + (peak.bits & 7) * 1.5 : undefined}
      {...peak}
    />
  ));
}

/** The far side, drawn from the Stellar account. */
function FarRanges() {
  const span = { from: STRIP.left, to: RIGHT, count: 57 };
  const back = farRidge(digits.slice(0, 28), { ...span, base: RISE * 0.62, amplitude: RISE * 0.52 });
  const front = farRidge(digits.slice(28), { ...span, base: RISE * 0.8, amplitude: RISE * 0.4 });
  return (
    <>
      <path d={landPath(back, RISE * 1.5)} fill={palette.tealLight} />
      <path d={landPath(front, RISE * 1.5)} fill={palette.teal} />
    </>
  );
}

function StageArt({ stage }: { stage: Stage }) {
  const { n, side, widths } = stage;
  const crest = crestLine(stage.seed, stage.offset, 0.64, 0.24);
  const ground = groundOn(crest);
  const land = landPath(crest, DEPTH + 20);
  const wide = wideRoad(stage);
  const narrow = narrowRoad(stage);
  const wideTop = wide[wide.length - 1][0];
  const narrowTop = narrow[narrow.length - 1][0];

  return (
    <div className="stage-art" aria-hidden="true">
      <svg viewBox={`${STRIP.left} ${-HEADROOM} ${STRIP.width} ${DEPTH + HEADROOM}`}>
        <defs>
          <HandCutFilter id={`stage-${n}-cut`} x={STRIP.left - 10} y={-HEADROOM - 10} width={STRIP.width + 20} height={DEPTH + HEADROOM + 20} />
          <clipPath id={`stage-${n}-land`}>
            <path d={land} />
          </clipPath>
        </defs>
        <g filter={`url(#stage-${n}-cut)`}>
          {n === 1 && <RangeBehind />}
          {n === 2 && (
            <>
              <g className="wide-only">
                <Sun x={wideTop} y={ground(wideTop) + 10} r={168} tone="ember" />
              </g>
              <g className="narrow-only">
                <Sun x={narrowTop} y={ground(narrowTop) + 10} r={132} tone="ember" />
              </g>
            </>
          )}
          {n === 3 && <FarRanges />}
          <path d={land} fill={GROUND[n]} />
          <g clipPath={`url(#stage-${n}-land)`}>
            <g className="wide-only">
              <Road points={wide} nearWidth={widths[0] * 1.11} farWidth={widths[1]} marking={[2.6, "11 12"]} />
            </g>
            <g className="narrow-only">
              <Road points={narrow} nearWidth={66} farWidth={32} marking={[3.2, "13 15"]} />
            </g>
          </g>
          {n === 3 && (
            <g fill={palette.ink}>
              {TREES.map(([x, scale]) => (
                <Tree key={x} x={x} y={ground(x) + 5} scale={scale} />
              ))}
            </g>
          )}
          <g className="wide-only">
            <KilometreStone n={n} cap={CAP[n]} x={stage.stone[0]} y={stage.stone[1]} />
          </g>
          <g className="narrow-only">
            <KilometreStone n={n} cap={CAP[n]} x={side * NARROW_STONE[0]} y={NARROW_STONE[1]} scale={1.25} />
          </g>
        </g>
      </svg>
    </div>
  );
}

const STEPS = [
  {
    title: "Connect the wallet you already have",
    body: "MetaMask, Coinbase Wallet, Rabby, a Ledger. Paso derives your Stellar account from your address. Nothing to install, nothing to back up.",
  },
  {
    title: "Bring USDC from Base",
    body: "One transaction on Base. About 20 seconds later it is native USDC in your Stellar account. No XLM, no trustline, no wrapped token.",
  },
  {
    title: "Sign what you see",
    body: "Your wallet shows the contract, the function and every argument. The account contract rebuilds that same message from what is about to run. If they differ, nothing happens.",
  },
] as const;

export function HowItWorks() {
  return (
    <section className="descent" id="how" aria-labelledby="how-title">
      {STAGES.map((stage, i) => (
        <div key={stage.n} className={`band stage s${stage.n}${stage.side < 0 ? " flip" : ""}`}>
          <StageArt stage={stage} />
          <div className="wrap">
            <div className="text">
              {i === 0 && (
                <h2 className="sign" id="how-title">
                  How it works
                </h2>
              )}
              <h3>
                <span className="vh">Step {stage.n}. </span>
                {STEPS[i].title}
              </h3>
              <p className="body">{STEPS[i].body}</p>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
