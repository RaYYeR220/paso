import { round } from "./geometry";
import { palette } from "./palette";

export type PeakShape = {
  /** Summit. */
  x: number;
  y: number;
  /** Rise over run of each flank; steeper is larger. */
  leftSlope: number;
  rightSlope: number;
  /** One byte of character: it tears the snow line and nicks the shaded face. */
  bits: number;
  /** A broad-shouldered peak, one of the pair that holds the pass. */
  twin?: boolean;
};

/** The outline of a peak standing on `base`. */
export function peakOutline(peak: PeakShape, base: number): string {
  const height = base - peak.y;
  const left = height / peak.leftSlope;
  const right = height / peak.rightSlope;
  const sag = height * 0.035;
  const mid = round(peak.y + height / 2 + sag);
  return `M${round(peak.x - left)} ${base}Q${round(peak.x - left / 2)} ${mid} ${round(peak.x)} ${round(peak.y)}Q${round(peak.x + right / 2)} ${mid} ${round(peak.x + right)} ${base}Z`;
}

export type PeakProps = PeakShape & {
  /** Unique within the document; names the peak's clip path. */
  id: string;
  base: number;
  tone: string;
  /** Depth of the snow cap. Leave out for a bare summit. */
  snow?: number;
};

/** One gouache peak: the body, a torn snow line and a shaded eastern face. */
export function Peak({ id, base, tone, snow, ...peak }: PeakProps) {
  const height = base - peak.y;
  const right = height / peak.rightSlope;
  const body = peakOutline(peak, base);

  let cap: string | undefined;
  if (snow !== undefined) {
    const span = snow / Math.min(peak.leftSlope, peak.rightSlope) + 14;
    const teeth = peak.twin ? 8 : 6;
    cap = `M${round(peak.x - height)} ${round(peak.y - 60)}L${round(peak.x + height)} ${round(peak.y - 60)}L${round(peak.x + height)} ${round(peak.y + snow)}`;
    for (let k = 0; k <= teeth; k++) {
      const drop = snow * (k % 2 ? 1.26 : 0.7) + ((peak.bits >> k) & 1) * snow * 0.09;
      cap += `L${round(peak.x + (1 - (2 * k) / teeth) * span)} ${round(peak.y + drop)}`;
    }
    cap += `L${round(peak.x - height)} ${round(peak.y + snow)}Z`;
  }

  const nick = (k: number) => (((peak.bits >> k) & 3) - 1.5) * 0.035;
  const fold = [
    [0.3 + nick(0), 0.7],
    [0.05 + nick(2), 0.53 + nick(1)],
    [0.22 + nick(4), 0.33 + nick(3)],
    [-0.01 + nick(6), 0.16 + nick(5)],
  ]
    .map(([across, down]) => `L${round(peak.x + right * across)} ${round(peak.y + height * down)}`)
    .join("");
  const face = `M${round(peak.x)} ${round(peak.y - 4)}L${round(peak.x + right + 20)} ${round(peak.y - 4)}L${round(peak.x + right + 20)} ${base}L${round(peak.x + right * 0.2)} ${base}${fold}Z`;

  return (
    <g>
      <clipPath id={id}>
        <path d={body} />
      </clipPath>
      <path d={body} fill={tone} {...(cap ? {} : { stroke: tone, strokeWidth: 4, strokeLinejoin: "round" as const })} />
      <g clipPath={`url(#${id})`}>
        {cap && <path d={cap} fill={palette.cream} />}
        <path d={face} fill={palette.shade} opacity=".44" />
      </g>
    </g>
  );
}
