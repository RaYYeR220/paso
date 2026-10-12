import { ribbon, type Point } from "./geometry";
import { palette } from "./palette";

export type RoadProps = {
  /** Centre line, from the near end to the far end. */
  points: readonly Point[];
  nearWidth: number;
  farWidth: number;
  /** Centre-line marking as `[strokeWidth, dashArray]`; leave out for a bare track. */
  marking?: readonly [number, string];
};

/** A cream road that tapers into the distance, with an optional dashed centre line. */
export function Road({ points, nearWidth, farWidth, marking }: RoadProps) {
  const road = ribbon(points, nearWidth, farWidth);
  return (
    <>
      <path d={road.outline} fill={palette.cream} />
      {marking && (
        <path d={road.centre} fill="none" stroke={palette.mustard} strokeWidth={marking[0]} strokeDasharray={marking[1]} strokeLinecap="round" />
      )}
    </>
  );
}
