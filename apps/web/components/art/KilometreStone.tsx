import { round } from "./geometry";
import { palette } from "./palette";

export type KilometreStoneProps = {
  /** The number painted on the stone. */
  n: number | string;
  /** Colour of the painted cap. */
  cap?: string;
  /** Where the foot of the stone meets the ground. */
  x?: number;
  y?: number;
  scale?: number;
};

/** A roadside kilometre stone, 92 × 128 at scale 1, standing on (x, y). */
export function KilometreStone({ n, cap = palette.mustard, x = 0, y = 0, scale = 1 }: KilometreStoneProps) {
  return (
    <g transform={`translate(${round(x)} ${round(y)}) scale(${scale}) translate(-46 -128)`}>
      <ellipse cx="50" cy="122" rx="40" ry="6" fill={palette.ink} opacity=".3" />
      <path d="M15 122L22 36Q22 6 46 6Q70 6 70 36L77 122Z" fill={palette.cream} />
      <path d="M22 36Q22 6 46 6Q70 6 70 36L70.9 47L21.1 47Z" fill={cap} />
      <path d="M59 47L70.9 47 77 122 66 122Z" fill={palette.ink} opacity=".13" />
      <text x="45.5" y="103" textAnchor="middle" className="art-numeral" fontWeight="900" fontSize="47" fill={palette.ink}>
        {n}
      </text>
    </g>
  );
}
