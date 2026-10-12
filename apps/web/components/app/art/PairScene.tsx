import { useId } from "react";
import {
  addressBytes,
  landBelow,
  mixHex,
  PALETTE,
  r,
  ribbon,
  strkeyDigits,
  type Point,
} from "./geometry";

interface Peak {
  x: number;
  y: number;
  /** Steepness of the left and right flank. */
  left: number;
  right: number;
}

export interface PairSceneProps {
  /** Drawn width and height, in pixels. */
  width: number;
  height: number;
  /** Where the pass sits, in pixels from the left edge. */
  passX: number;
  /** The Ethereum address: its bytes are the near range. */
  evmAddress?: string;
  /** The Stellar account: its digits are the two ranges beyond the pass. */
  stellarAddress?: string;
  /** Fewer, broader shapes for a narrow screen. */
  compact?: boolean;
}

function peakBody(peak: Peak, base: number): string {
  const rise = base - peak.y;
  const leftFoot = rise / peak.left;
  const rightFoot = rise / peak.right;
  const sag = rise * 0.035;
  return (
    `M${r(peak.x - leftFoot)} ${base}` +
    `Q${r(peak.x - leftFoot / 2)} ${r(peak.y + rise / 2 + sag)} ${r(peak.x)} ${r(peak.y)}` +
    `Q${r(peak.x + rightFoot / 2)} ${r(peak.y + rise / 2 + sag)} ${r(peak.x + rightFoot)} ${base}Z`
  );
}

function snowCap(peak: Peak, base: number, depth: number): string {
  const rise = base - peak.y;
  const span = depth / Math.min(peak.left, peak.right) + 5;
  const teeth = 6;
  let d = `M${r(peak.x - rise)} ${r(peak.y - 30)}L${r(peak.x + rise)} ${r(peak.y - 30)}L${r(peak.x + rise)} ${r(peak.y + depth)}`;
  for (let k = 0; k <= teeth; k += 1) {
    d += `L${r(peak.x + (1 - (2 * k) / teeth) * span)} ${r(peak.y + depth * (k % 2 ? 1.26 : 0.7))}`;
  }
  return `${d}L${r(peak.x - rise)} ${r(peak.y + depth)}Z`;
}

function shadedFlank(peak: Peak, base: number): string {
  const rise = base - peak.y;
  const rightFoot = rise / peak.right;
  const edge = [
    [0.3, 0.7],
    [0.05, 0.53],
    [0.22, 0.33],
    [-0.01, 0.16],
  ]
    .map(([across, down]) => `L${r(peak.x + rightFoot * across)} ${r(peak.y + rise * down)}`)
    .join("");
  return (
    `M${r(peak.x)} ${r(peak.y - 4)}L${r(peak.x + rightFoot + 20)} ${r(peak.y - 4)}` +
    `L${r(peak.x + rightFoot + 20)} ${base}L${r(peak.x + rightFoot * 0.2)} ${base}${edge}Z`
  );
}

/**
 * The account as terrain. The near range is the Ethereum address, one peak to
 * a byte, with two of them holding the pass; the pale ranges beyond are drawn
 * from the Stellar account; one road goes over.
 */
export function PairScene({ width, height, passX, evmAddress, stellarAddress, compact = false }: PairSceneProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const bytes = addressBytes(evmAddress);
  const digits = strkeyDigits(stellarAddress);
  const base = height + 8;
  const half = compact ? 34 : 52;

  const near = bytes.slice(0, compact ? 6 : 14);
  const gaps = near.map((byte) => 0.5 + ((byte & 31) / 31) * 1.2);
  const totalGap = gaps.reduce((sum, gap) => sum + gap, 0);
  const peaks: Peak[] = [];
  let x = -30;
  near.forEach((byte, i) => {
    peaks.push({
      x,
      y: height * (0.74 - Math.pow(byte / 255, 1.4) * 0.56),
      left: 0.95 + ((byte >> 2) & 3) * 0.18,
      right: 1.25 + ((byte >> 4) & 3) * 0.24,
    });
    x += (gaps[i] / totalGap) * (passX - half - 30);
  });
  peaks.push(
    { x: passX - half, y: height * 0.1, left: 1.15, right: 1.5 },
    { x: passX + half, y: height * 0.17, left: 1.5, right: 1.25 },
  );
  peaks.sort((a, b) => a.y - b.y);

  const farCount = compact ? 8 : 22;
  const farRange = (source: number[], foot: number, lift: number): Point[] =>
    source.map((digit, j) => [
      passX - 20 + (j * (width + 80 - passX)) / (source.length - 1),
      foot - Math.pow(digit / 31, 1.3) * lift,
    ]);
  const farBack = farRange(digits.slice(0, farCount), height * 0.66, height * 0.5);
  const farFront = farRange(digits.slice(28, 28 + farCount), height * 0.82, height * 0.4);

  const rolling = (foot: number, swing: number, stride: number, offset: number): Point[] => {
    const steps = Math.max(3, Math.round(width / 200));
    return Array.from({ length: steps + 1 }, (_, j): Point => [
      -60 + (j * (width + 120)) / steps,
      foot + (bytes[(j * stride + offset) % 20] / 255 - 0.5) * 2 * swing,
    ]);
  };
  const ground = rolling(height * 0.78, height * 0.05, 3, 1);
  const foreground = rolling(height * 0.93, height * 0.045, 7, 4);

  const road = ribbon(
    [
      [passX - 330, height * 1.04],
      [passX - 215, height * 0.93],
      [passX - 120, height * 0.9],
      [passX - 28, height * 0.82],
      [passX + 1, height * 0.66],
    ],
    compact ? 9 : 13,
    2.5,
  );

  const sun: [number, string][] = [
    [height * 1.02, "#F1D8A1"],
    [height * 0.78, "#EECA80"],
    [height * 0.56, "#EBBB5E"],
    [height * 0.34, "#FCF3DA"],
  ];

  return (
    <svg
      className="scene"
      viewBox={`0 0 ${r(width)} ${r(height)}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter id={`${id}-cut`} filterUnits="userSpaceOnUse" x={-10} y={-10} width={r(width + 20)} height={r(height + 20)}>
          <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="9" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="4" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {peaks.map((peak, i) => (
          <clipPath key={i} id={`${id}-peak${i}`}>
            <path d={peakBody(peak, base)} />
          </clipPath>
        ))}
        <clipPath id={`${id}-ground`}>
          <path d={landBelow(ground, base)} />
        </clipPath>
      </defs>
      <g filter={`url(#${id}-cut)`}>
        {sun.map(([radius, fill]) => (
          <circle key={fill} cx={r(passX)} cy={r(height * 0.62)} r={r(radius)} fill={fill} />
        ))}
        <path d={landBelow(farBack, base)} fill={PALETTE.teal200} />
        <path d={landBelow(farFront, base)} fill={PALETTE.teal300} />
        {peaks.map((peak, i) => (
          <g key={i}>
            <path d={peakBody(peak, base)} fill={mixHex("#D5693A", "#BF4C29", Math.min(1, i / 9))} />
            <g clipPath={`url(#${id}-peak${i})`}>
              {peak.y < height * 0.34 ? <path d={snowCap(peak, base, height * 0.15)} fill={PALETTE.cream} /> : null}
              <path d={shadedFlank(peak, base)} fill="#6E2318" opacity={0.44} />
            </g>
          </g>
        ))}
        <path d={landBelow(ground, base)} fill={PALETTE.tealDeep} />
        <g clipPath={`url(#${id}-ground)`}>
          <path d={road} fill={PALETTE.cream} />
        </g>
        <path d={landBelow(foreground, base)} fill={PALETTE.cream} />
      </g>
    </svg>
  );
}
