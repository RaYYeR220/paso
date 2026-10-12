import { accountDigits, addressBytes, heightAt, ribbon, rollingHills, sample, type Point } from "@/components/art";

import { DEMO_ACCOUNT, DEMO_ADDRESS } from "./demo";

/**
 * Every band below the hero is one more range, drawn on a 3000-unit strip
 * centred on the page. A range rises `RISE` units over the band behind it.
 * Wide screens show the strip at one unit per pixel; narrow ones scale it so
 * that 715 units span the viewport.
 */
export const RISE = 132;
export const STRIP = { left: -1500, width: 3000 } as const;
export const NARROW_EDGE = 357;

export const bytes = addressBytes(DEMO_ADDRESS);
export const digits = accountDigits(DEMO_ACCOUNT);

export function crestLine(seed: number, offset: number, base = 0.66, amplitude = 0.2): Point[] {
  return rollingHills(bytes, {
    from: STRIP.left,
    to: STRIP.left + STRIP.width,
    step: 187.5,
    base: RISE * base,
    amplitude: RISE * amplitude,
    seed,
    offset,
  });
}

export type Stage = {
  n: 1 | 2 | 3;
  seed: number;
  offset: number;
  /** Which side of the page the road keeps to: 1 right, −1 left. */
  side: 1 | -1;
  widths: readonly [number, number];
  /** Kilometre stone on wide screens: centre x, and y of its foot. */
  stone: Point;
};

export const STAGES: readonly Stage[] = [
  { n: 1, seed: 3, offset: 1, side: 1, widths: [50, 30], stone: [191, 420] },
  { n: 2, seed: 7, offset: 4, side: -1, widths: [58, 34], stone: [-287, 380] },
  { n: 3, seed: 11, offset: 2, side: 1, widths: [66, 38], stone: [191, 400] },
];

/** Band heights the wide roads are laid out for; a taller band just shows more road. */
const BAND = { 1: 600, 2: 520, 3: 560 } as const;

/** The road on wide screens, near end first: up past the stone and over the crest. */
export function wideRoad({ n, side, stone: [x, y] }: Stage): Point[] {
  const foot = BAND[n] + RISE;
  return [
    [x - side * 360, foot + 330],
    [x - side * 290, foot + 80],
    [x - side * 190, y + (foot - y) * 0.5],
    [x - side * 84, y + 4],
    [x - side * 58, y - 98],
    [x + side * 20, RISE + (y - RISE - 124) * 0.42],
    [x + side * 110, RISE * 0.25 - 50],
  ];
}

export const NARROW_STONE: Point = [214, 336];

/** On narrow screens the road keeps to a gutter beside the text. */
export function narrowRoad({ side }: Stage): Point[] {
  return (
    [
      [286, 1580],
      [262, 1150],
      [290, 860],
      [248, 610],
      [308, 414],
      [292, 250],
      [226, 120],
      [190, -30],
    ] as const
  ).map(([x, y]) => [side * x, y]);
}

/** Where the last road meets the border, on wide and on narrow screens. */
export const border = (() => {
  const last = STAGES[2];
  const [near, far] = last.widths;
  const crossing = BAND[3] + RISE - RISE * 0.36;
  const road = ribbon(wideRoad(last), near * 1.11, far).points;
  const wide = (road.find((point) => point[1] <= crossing) ?? road[0])[0];
  return { wide, narrow: 240, narrowScale: 0.8 };
})();

export const groundOn = (crest: readonly Point[]) => {
  const line = sample(crest);
  return (x: number) => heightAt(line, x);
};
