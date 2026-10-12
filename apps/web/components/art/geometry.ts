export type Point = readonly [number, number];

type Segment = readonly [Point, Point, Point, Point];

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const round = (value: number) => Math.round(value * 10) / 10;

/** The 20 bytes of an Ethereum address. Anything malformed reads as zeros, so drawing never throws. */
export function addressBytes(address: string): number[] {
  const hex = address.replace(/^0x/i, "").padEnd(40, "0");
  return Array.from({ length: 20 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0);
}

/** The 56 base-32 digits of a Stellar address, each 0–31. */
export function accountDigits(account: string): number[] {
  const digits = Array.from(account.toUpperCase().slice(0, 56), (char) => Math.max(0, BASE32.indexOf(char)));
  while (digits.length < 56) digits.push(0);
  return digits;
}

/** Catmull-Rom through the points, as cubic Bézier segments. */
function segments(points: readonly Point[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    out.push([
      p1,
      [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      p2,
    ]);
  }
  return out;
}

/** Path commands for a smooth line through the points, continuing from the first one. */
export function curve(points: readonly Point[]): string {
  return segments(points)
    .map(([, a, b, end]) => `C${round(a[0])} ${round(a[1])} ${round(b[0])} ${round(b[1])} ${round(end[0])} ${round(end[1])}`)
    .join("");
}

/** The same smooth line as a polyline, `steps` points per segment. */
export function sample(points: readonly Point[], steps = 14): Point[] {
  const out: Point[] = [];
  for (const [a, b, c, d] of segments(points)) {
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push([
        u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
        u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
      ]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Height of a left-to-right polyline at `x`. */
export function heightAt(line: readonly Point[], x: number): number {
  for (let i = 1; i < line.length; i++) {
    if (line[i][0] >= x) {
      const a = line[i - 1];
      const b = line[i];
      const t = (x - a[0]) / (b[0] - a[0] || 1);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return line[line.length - 1][1];
}

/** A closed shape: everything under the crest, down to `bottom`. */
export function landPath(crest: readonly Point[], bottom: number): string {
  const first = crest[0];
  const last = crest[crest.length - 1];
  return `M${round(first[0])} ${round(bottom)}L${round(first[0])} ${round(first[1])}${curve(crest)}L${round(last[0])} ${round(bottom)}Z`;
}

/** Rolling ground: one point every `step`, its height taken from the address bytes. */
export function rollingHills(
  bytes: readonly number[],
  { from, to, step, base, amplitude, seed, offset }: { from: number; to: number; step: number; base: number; amplitude: number; seed: number; offset: number },
): Point[] {
  const points: Point[] = [];
  for (let x = from, j = 0; x <= to; x += step, j++) {
    points.push([x, base + (bytes[(j * seed + offset) % bytes.length] / 255 - 0.5) * 2 * amplitude]);
  }
  return points;
}

/** A distant ridge: one summit per base-32 digit, repeating the digits if the span needs more. */
export function farRidge(
  digits: readonly number[],
  { from, to, count, base, amplitude }: { from: number; to: number; count: number; base: number; amplitude: number },
): Point[] {
  return Array.from({ length: count }, (_, j) => [
    from + (j * (to - from)) / (count - 1),
    base - Math.pow(digits[j % digits.length] / 31, 1.3) * amplitude,
  ]);
}

export type Ribbon = { outline: string; centre: string; points: Point[] };

/**
 * A road in perspective. The points run from the near end to the far end; the
 * ribbon tapers from `nearWidth` to `farWidth` and thins where it runs across the slope.
 */
export function ribbon(points: readonly Point[], nearWidth: number, farWidth: number): Ribbon {
  const line = sample(points, 16);
  const count = line.length;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(count - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    const half = (nearWidth + (farWidth - nearWidth) * Math.pow(i / (count - 1), 0.85)) / 2;
    const nx = (-dy / length) * half;
    const ny = (dx / length) * half * 0.42;
    left.push(`${round(line[i][0] + nx)} ${round(line[i][1] + ny)}`);
    right.push(`${round(line[i][0] - nx)} ${round(line[i][1] - ny)}`);
  }
  return {
    outline: `M${left.join("L")}L${right.reverse().join("L")}Z`,
    centre: `M${line.map((p) => `${round(p[0])} ${round(p[1])}`).join("L")}`,
    points: line,
  };
}

/** Linear blend of two `#rrggbb` colours. */
export function mix(a: string, b: string, t: number): string {
  const channel = (k: number) =>
    Math.round(parseInt(a.slice(k, k + 2), 16) * (1 - t) + parseInt(b.slice(k, k + 2), 16) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}
