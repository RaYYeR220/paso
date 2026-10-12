import { round } from "./geometry";
import { palette } from "./palette";

const RINGS = {
  dawn: [
    [1, "#F1D8A1"],
    [0.779, "#EECA80"],
    [0.571, "#EBBB5E"],
    [0.381, "#E6AC3C"],
    [0.212, palette.glow],
  ],
  ember: [
    [1, "#BD5A28"],
    [0.738, "#CF7A29"],
    [0.5, palette.mustard],
    [0.286, palette.glow],
  ],
} as const;

/** Concentric flat rings. `dawn` sits in a pale sky, `ember` behind a dark crest. */
export function Sun({ x, y, r, tone = "dawn" }: { x: number; y: number; r: number; tone?: keyof typeof RINGS }) {
  return (
    <g>
      {RINGS[tone].map(([share, fill]) => (
        <circle key={share} cx={round(x)} cy={round(y)} r={round(r * share)} fill={fill} />
      ))}
    </g>
  );
}
