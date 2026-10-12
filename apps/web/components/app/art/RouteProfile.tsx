import { useId } from "react";
import { PALETTE, polyline, r, sample, type Point } from "./geometry";

export type StationStatus = "waiting" | "active" | "done" | "failed";

export interface RouteProfileProps {
  /** Burn at the near foot, attestation at the pass, mint at the far foot. */
  stations: readonly [StationStatus, StationStatus, StationStatus];
  /** How far the traveller is towards the active station, 0 to 1. */
  progress?: number;
  label: string;
}

const WIDTH = 392;
const TOP = -30;
const BOTTOM = 174;

const RIDGE: Point[] = [
  [-8, 146],
  [52, 138],
  [124, 76],
  [196, 14],
  [268, 76],
  [340, 138],
  [400, 146],
];
const STATION_X = [52, 196, 340] as const;

const CREST = sample(RIDGE, 22);
/** The road runs a little under the crest line. */
const ROAD: Point[] = CREST.map(([x, y]) => [x, y + 9]);
const STATION_INDEX = STATION_X.map((x) => ROAD.findIndex((point) => point[0] >= x));
const STATION_POINT = STATION_INDEX.map((index) => ROAD[index]);

function Station({ status, at }: { status: StationStatus; at: Point }) {
  const place = `translate(${r(at[0])} ${r(at[1])})`;
  switch (status) {
    case "done":
      return (
        <g transform={place}>
          <circle r={13} fill={PALETTE.ink} stroke={PALETTE.cream} strokeWidth={3} />
          <path
            d="M-5.5 .5L-1.8 4.2L5.6 -3.8"
            fill="none"
            stroke={PALETTE.cream}
            strokeWidth={2.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      );
    case "active":
      return (
        <g transform={place}>
          <circle className="pulse" r={13} fill="none" stroke={PALETTE.ink} strokeWidth={2} />
          <circle r={13} fill={PALETTE.mustard} stroke={PALETTE.ink} strokeWidth={3} />
          <circle r={4} fill={PALETTE.ink} />
        </g>
      );
    case "failed":
      return (
        <g transform={place}>
          <circle r={13} fill={PALETTE.terraGround} stroke={PALETTE.ink} strokeWidth={3} />
          <path d="M-4.6 -4.6L4.6 4.6M4.6 -4.6L-4.6 4.6" stroke={PALETTE.cream} strokeWidth={2.8} strokeLinecap="round" />
        </g>
      );
    default:
      return (
        <g transform={place}>
          <circle r={12} fill={PALETTE.cream} stroke={PALETTE.ink} strokeWidth={2.2} strokeDasharray="3.4 3.4" />
        </g>
      );
  }
}

/**
 * The transfer as a route over the pass: Base at the foot on the terracotta
 * side, Circle's attestation at the pass in the sun, Stellar at the teal foot.
 */
export function RouteProfile({ stations, progress = 0.5, label }: RouteProfileProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const area = `${polyline(CREST)}L400 ${BOTTOM + 12}L-8 ${BOTTOM + 12}Z`;

  const reached = stations.lastIndexOf("done");
  const heading = stations.findIndex((status) => status === "active" || status === "failed");
  const moving = reached >= 0 && heading > reached && stations[heading] === "active";

  let travelled = reached >= 0 ? STATION_INDEX[reached] : -1;
  if (moving) {
    const span = STATION_INDEX[heading] - STATION_INDEX[reached];
    const share = 0.12 + Math.min(1, Math.max(0, progress)) * 0.72;
    travelled = STATION_INDEX[reached] + Math.round(span * share);
  }
  const walked = reached >= 0 ? ROAD.slice(STATION_INDEX[0], travelled + 1) : [];
  const ahead = ROAD.slice(Math.max(travelled, 0));
  const traveller = moving ? ROAD[travelled] : null;

  return (
    <svg className="profile" viewBox={`0 ${TOP} ${WIDTH} ${BOTTOM - TOP}`} role="img" aria-label={label}>
      <defs>
        <clipPath id={`${id}-near`}>
          <rect x={-10} y={-40} width={206} height={230} />
        </clipPath>
        <clipPath id={`${id}-far`}>
          <rect x={196} y={-40} width={214} height={230} />
        </clipPath>
        <filter id={`${id}-cut`} filterUnits="userSpaceOnUse" x={-10} y={-40} width={412} height={230}>
          <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="4" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <circle cx={196} cy={24} r={56} fill={PALETTE.sky} />
      <circle cx={196} cy={24} r={41} fill="#EDC978" />
      <circle cx={196} cy={24} r={27} fill="#E6AC3C" />
      <g filter={`url(#${id}-cut)`}>
        <path d={area} fill={PALETTE.terracotta} clipPath={`url(#${id}-near)`} />
        <path d={area} fill={PALETTE.teal} clipPath={`url(#${id}-far)`} />
        <path
          d={polyline(ROAD)}
          fill="none"
          stroke={PALETTE.cream}
          strokeWidth={9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      {ahead.length > 1 ? (
        <path
          d={polyline(ahead)}
          fill="none"
          stroke={PALETTE.mustard}
          strokeWidth={2.2}
          strokeDasharray="6 6"
          strokeLinecap="round"
        />
      ) : null}
      {walked.length > 1 ? (
        <path d={polyline(walked)} fill="none" stroke={PALETTE.ink} strokeWidth={3.4} strokeLinecap="round" />
      ) : null}
      {traveller ? (
        <circle
          cx={r(traveller[0])}
          cy={r(traveller[1])}
          r={6.5}
          fill={PALETTE.ink}
          stroke={PALETTE.cream}
          strokeWidth={2.5}
        />
      ) : null}
      {stations.map((status, i) => (
        <Station key={i} status={status} at={STATION_POINT[i]} />
      ))}
    </svg>
  );
}
