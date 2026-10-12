import { round } from "./geometry";
import { palette } from "./palette";

export type BorderPostProps = {
  /** Where the road crosses the border. */
  x: number;
  /** Ground height at `x`. Ignored when `ground` is given. */
  y?: number;
  /** Ground height for any x, when the post stands on uneven ground. */
  ground?: (x: number) => number;
  scale?: number;
  /**
   * Boom across the road. Leave undefined to let an ancestor decide with
   * `data-boom="down"`, so the state can change without re-rendering the art.
   */
  lowered?: boolean;
};

const STRIPES = Array.from({ length: 9 }, (_, i) => i);

/** A customs hut, a striped boom on its post, and the rest the boom drops onto. */
export function BorderPost({ x, y = 0, ground, scale = 1, lowered }: BorderPostProps) {
  const groundAt = (dx: number) => (ground ? ground(x + dx * scale) + 3 : y);
  const stand = (dx: number, lift = 0) => `translate(${round(x + dx * scale)} ${round(groundAt(dx) - lift * scale)}) scale(${scale})`;

  return (
    <g>
      <g transform={stand(-190)}>
        <rect x="-38" y="-58" width="76" height="60" fill={palette.cream} />
        <path d="M-52 -56L0 -92L52 -56Z" fill={palette.terracotta} />
        <rect x="-26" y="-40" width="18" height="42" fill={palette.ink} />
        <rect x="6" y="-40" width="20" height="18" fill={palette.mustard} />
        <path d="M38 -58L38 2L50 2L50 -57Z" fill={palette.ink} opacity=".16" />
      </g>
      <g transform={stand(-63.5)}>
        <rect x="-6.5" y="-84" width="13" height="88" fill={palette.cream} />
        <rect x="-6.5" y="-84" width="13" height="12" fill={palette.mustard} />
      </g>
      <g transform={stand(124)}>
        <rect x="-4.5" y="-62" width="9" height="66" fill={palette.cream} />
        <rect x="-12.5" y="-66" width="25" height="7" fill={palette.cream} />
      </g>
      <g transform={stand(-63.5, 72)}>
        <g className="art-boom" data-lowered={lowered}>
          <rect x="-52" y="-12" width="30" height="24" fill={palette.terracottaDeep} />
          {STRIPES.map((i) => (
            <rect key={i} x={-30 + i * 24} y="-6.5" width="24" height="13" fill={i % 2 ? palette.cream : palette.terracotta} />
          ))}
          <circle cx="190" cy="0" r="9" fill={palette.mustard} />
        </g>
      </g>
    </g>
  );
}
