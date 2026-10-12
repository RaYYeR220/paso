import type { ReactNode } from "react";

import { HandCutFilter, landPath } from "@/components/art";

import { crestLine, groundOn, RISE, STRIP } from "./terrain";

type CrestProps = {
  id: string;
  fill: string;
  seed: number;
  offset: number;
  /** Anything standing on the crest, given the ground height at any x. */
  children?: (ground: (x: number) => number) => ReactNode;
};

/** The skyline of a band, rising over the band before it. */
export function Crest({ id, fill, seed, offset, children }: CrestProps) {
  const crest = crestLine(seed, offset);
  return (
    <svg className="crest" viewBox={`${STRIP.left} 0 ${STRIP.width} ${RISE + 2}`} aria-hidden="true">
      <defs>
        <HandCutFilter id={id} x={STRIP.left - 10} y={-260} width={STRIP.width + 20} height={RISE + 290} />
      </defs>
      <g filter={`url(#${id})`}>
        <path d={landPath(crest, RISE + 16)} fill={fill} />
        {children?.(groundOn(crest))}
      </g>
    </svg>
  );
}
