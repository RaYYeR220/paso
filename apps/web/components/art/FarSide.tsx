import { accountDigits, farRidge, landPath } from "./geometry";
import { HandCutFilter } from "./HandCut";
import { palette } from "./palette";
import { Bird, Cloud } from "./Scenery";
import { Sun } from "./Sun";

const WIDTH = 1440;
const HEIGHT = 380;

export type FarSideProps = {
  /** Stellar account whose base-32 digits set every summit. */
  account: string;
  /** Prefix for SVG ids. Set it when two of these share a page. */
  id?: string;
  className?: string;
};

/**
 * The far side of the pass: three pale ranges under a low sun, drawn from a
 * Stellar account. A 1440 × 380 strip that covers its box from the left.
 */
export function FarSide({ account, id = "far-side", className }: FarSideProps) {
  const digits = accountDigits(account);
  const span = { from: -60, to: WIDTH + 60 };
  const back = farRidge(digits.slice(0, 26), { ...span, count: 26, base: HEIGHT * 0.6, amplitude: HEIGHT * 0.3 });
  const middle = farRidge(digits.slice(26, 52), { ...span, count: 26, base: HEIGHT * 0.76, amplitude: HEIGHT * 0.22 });
  const front = farRidge(digits.slice(5, 20), { ...span, count: 15, base: HEIGHT * 0.9, amplitude: HEIGHT * 0.13 });

  return (
    <svg className={className} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMinYMax slice" aria-hidden="true">
      <defs>
        <HandCutFilter id={`${id}-cut`} x={-70} y={-10} width={WIDTH + 140} height={HEIGHT + 30} />
      </defs>
      <g filter={`url(#${id}-cut)`}>
        <Sun x={WIDTH * 0.3} y={HEIGHT * 0.7} r={258} />
        <g fill={palette.paper}>
          <Cloud x={WIDTH * 0.58} y={HEIGHT * 0.16} scale={0.9} />
        </g>
        <g fill={palette.ink}>
          <Bird x={WIDTH * 0.46} y={HEIGHT * 0.24} scale={0.5} />
          <Bird x={WIDTH * 0.5} y={HEIGHT * 0.32} scale={0.34} />
        </g>
        <path d={landPath(back, HEIGHT + 12)} fill={palette.tealPale} />
        <path d={landPath(middle, HEIGHT + 12)} fill={palette.tealLight} />
        <path d={landPath(front, HEIGHT + 12)} fill={palette.teal} />
      </g>
    </svg>
  );
}
