import type { CSSProperties } from "react";

import { accountDigits, addressBytes, heightAt, landPath, mix, rollingHills, sample, type Point } from "./geometry";
import { HandCutFilter } from "./HandCut";
import { palette } from "./palette";
import { Peak, peakOutline, type PeakShape } from "./Peak";
import { Road } from "./Road";
import { Bird, Cloud, Tree } from "./Scenery";
import { Sun } from "./Sun";

const HEIGHT = 600;
const LEFT = -220;
const RIGHT = 2040;
const PASS_X = 1024;
const PASS_Y = 392;
const GROUND = HEIGHT + 6;

const TREES: readonly Point[] = [
  [-930, 1.25],
  [-878, 0.86],
  [-642, 1.05],
  [214, 1.34],
  [270, 0.9],
  [488, 1.12],
  [760, 0.8],
];

export type PassSceneProps = {
  /** Ethereum address: its 20 bytes are the 20 terracotta peaks on this side. */
  address: string;
  /** Stellar account: its 56 base-32 digits draw the two pale ranges beyond the pass. */
  account: string;
  /** Prefix for SVG ids. Set it when two scenes share a page. */
  id?: string;
  className?: string;
};

/**
 * The pass, as a poster: sun in the gap, the far side behind it, the range in
 * front, foothills and a road climbing through. Fills its container, keeps
 * the pass at `--pass-at` (default 50%) and crops the flanks. The eight layers
 * shift with `--drift` (−1…1) by depth.
 */
export function PassScene({ address, account, id = "pass", className }: PassSceneProps) {
  const bytes = addressBytes(address);
  const digits = accountDigits(account);

  const distant = (slice: number[], base: number, amplitude: number, saddle: number): Point[] =>
    slice.map((digit, j) => {
      const x = LEFT + (j * (RIGHT - LEFT)) / (slice.length - 1);
      const y = base - Math.pow(digit / 31, 1.3) * amplitude;
      return [x, Math.abs(x - PASS_X) < 130 ? Math.min(y, saddle) : y];
    });
  const farther = distant(digits.slice(0, 28), 348, 84, 322);
  const nearer = distant(digits.slice(28), 390, 58, 366);

  const peaks: PeakShape[] = [];
  const strew = (run: number[], from: number, to: number) => {
    const gaps = run.map((byte) => 0.45 + ((byte & 31) / 31) * 1.3);
    const total = gaps.reduce((sum, gap) => sum + gap, 0);
    let x = from;
    run.forEach((byte, i) => {
      peaks.push({
        x,
        y: 356 - Math.pow(byte / 255, 1.5) * 208,
        leftSlope: 0.92 + ((byte >> 2) & 3) * 0.19,
        rightSlope: 1.22 + ((byte >> 4) & 3) * 0.27,
        bits: byte,
      });
      x += (gaps[i] / total) * (to - from);
    });
  };
  strew(bytes.slice(0, 9), -176, 772);
  const leftSummit = 142 + (bytes[10] % 20);
  const rightSummit = 160 + (bytes[11] % 24);
  peaks.push({ x: PASS_X - 168, y: leftSummit, leftSlope: 1.22, rightSlope: (PASS_Y - leftSummit) / 168, bits: bytes[9], twin: true });
  peaks.push({ x: PASS_X + 160, y: rightSummit, leftSlope: (PASS_Y - rightSummit) / 160, rightSlope: 1.62, bits: bytes[12], twin: true });
  strew(bytes.slice(13), 1336, 2020);
  peaks.sort((a, b) => a.y - b.y);

  const hill = (base: number, amplitude: number, step: number, seed: number, offset: number) =>
    rollingHills(bytes, { from: LEFT, to: RIGHT + step, step, base, amplitude, seed, offset });
  const foothill = hill(430, 22, 150, 3, 1);
  const slope = hill(476, 24, 190, 7, 4);
  const treeline = hill(526, 26, 236, 11, 2);
  const slab = hill(573, 19, 310, 13, 6);
  const treelineEdge = sample(treeline);

  const sunX = PASS_X + 14;
  const layers: { depth: number; art: React.ReactNode }[] = [
    {
      depth: 0.03,
      art: (
        <>
          <rect x={LEFT} y={-10} width={RIGHT - LEFT} height={HEIGHT + 20} fill={palette.sky} />
          <Sun x={sunX} y={284} r={452} />
          <g fill={palette.paper}>
            <Cloud x={PASS_X - 800} y={148} />
            <Cloud x={PASS_X + 420} y={86} scale={0.78} />
          </g>
          <g fill={palette.ink}>
            <Bird x={PASS_X - 372} y={206} scale={0.62} />
            <Bird x={PASS_X - 318} y={236} scale={0.4} />
            <Bird x={PASS_X + 352} y={176} scale={0.5} />
          </g>
        </>
      ),
    },
    { depth: 0.1, art: <path d={landPath(farther, GROUND)} fill={palette.tealPale} /> },
    { depth: 0.16, art: <path d={landPath(nearer, GROUND)} fill={palette.tealLight} /> },
    {
      depth: 0.3,
      art: (
        <>
          <clipPath id={`${id}-range`}>
            {peaks.map((peak, i) => (
              <path key={i} d={peakOutline(peak, GROUND)} />
            ))}
          </clipPath>
          {peaks.map((peak, i) => (
            <Peak
              key={i}
              id={`${id}-peak-${i}`}
              base={GROUND}
              tone={mix(palette.terracottaLight, "#BF4C29", Math.min(1, i / 12))}
              snow={peak.y < 242 ? (peak.twin ? 74 + (peak.bits & 7) * 2 : 30 + (peak.bits & 7) * 4) : undefined}
              {...peak}
            />
          ))}
          <g clipPath={`url(#${id}-range)`}>
            <Road points={[[PASS_X - 66, 452], [PASS_X - 30, 424], [PASS_X - 8, 404], [PASS_X + 1, 380]]} nearWidth={7.5} farWidth={2.2} />
          </g>
        </>
      ),
    },
    {
      depth: 0.46,
      art: (
        <>
          <clipPath id={`${id}-foothill`}>
            <path d={landPath(foothill, GROUND)} />
          </clipPath>
          <path d={landPath(foothill, GROUND)} fill={palette.teal} />
          <g clipPath={`url(#${id}-foothill)`}>
            <Road points={[[PASS_X - 214, 492], [PASS_X - 150, 466], [PASS_X - 92, 448], [PASS_X - 52, 414]]} nearWidth={13} farWidth={8} />
          </g>
        </>
      ),
    },
    {
      depth: 0.62,
      art: (
        <>
          <clipPath id={`${id}-slope`}>
            <path d={landPath(slope, GROUND)} />
          </clipPath>
          <path d={landPath(slope, GROUND)} fill={palette.tealDeep} />
          <g clipPath={`url(#${id}-slope)`}>
            <Road
              points={[[PASS_X - 232, 548], [PASS_X - 160, 516], [PASS_X - 118, 494], [PASS_X - 150, 472], [PASS_X - 196, 446]]}
              nearWidth={25}
              farWidth={14}
              marking={[1.6, "5 7"]}
            />
          </g>
        </>
      ),
    },
    {
      depth: 0.82,
      art: (
        <>
          <clipPath id={`${id}-treeline`}>
            <path d={landPath(treeline, GROUND)} />
          </clipPath>
          <path d={landPath(treeline, GROUND)} fill={palette.ink} />
          <g fill={palette.ink}>
            {TREES.map(([dx, scale]) => (
              <Tree key={dx} x={PASS_X + dx} y={heightAt(treelineEdge, PASS_X + dx) + 5} scale={scale} />
            ))}
          </g>
          <g clipPath={`url(#${id}-treeline)`}>
            <Road
              points={[[PASS_X - 500, 660], [PASS_X - 452, 592], [PASS_X - 372, 556], [PASS_X - 268, 536], [PASS_X - 196, 498]]}
              nearWidth={62}
              farWidth={27}
              marking={[2.6, "11 12"]}
            />
          </g>
        </>
      ),
    },
    { depth: 1, art: <path d={landPath(slab, GROUND)} fill={palette.mustard} /> },
  ];

  return (
    <div className={className ? `art-pass ${className}` : "art-pass"} aria-hidden="true">
      {layers.map(({ depth, art }, i) => (
        <svg
          key={depth}
          className="art-pass-layer"
          viewBox={`${LEFT} 0 ${RIGHT - LEFT} ${HEIGHT}`}
          preserveAspectRatio="xMidYMax slice"
          style={{ "--depth": depth } as CSSProperties}
        >
          {i === 0 && (
            <defs>
              <HandCutFilter id={`${id}-cut`} x={LEFT} y={-20} width={RIGHT - LEFT} height={HEIGHT + 40} />
            </defs>
          )}
          <g filter={`url(#${id}-cut)`}>{art}</g>
        </svg>
      ))}
    </div>
  );
}
