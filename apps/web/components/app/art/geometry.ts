export type Point = readonly [number, number];

type Segment = readonly [Point, Point, Point, Point];

export const PALETTE = {
  cream: "#F8EDD2",
  sky: "#F3E1B6",
  mustard: "#E0A227",
  terracotta: "#C8552D",
  terraGround: "#AE4726",
  teal200: "#A9CFC0",
  teal300: "#62AA9E",
  teal: "#2F8F86",
  tealDeep: "#17605F",
  ink: "#0B3436",
} as const;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** One decimal is plenty for a drawing, and keeps server and browser output identical. */
export function r(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A smooth curve through every point, as cubic Bézier segments. */
function segments(points: readonly Point[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const before = points[i - 1] ?? points[i];
    const from = points[i];
    const to = points[i + 1];
    const after = points[i + 2] ?? to;
    out.push([
      from,
      [from[0] + (to[0] - before[0]) / 6, from[1] + (to[1] - before[1]) / 6],
      [to[0] - (after[0] - from[0]) / 6, to[1] - (after[1] - from[1]) / 6],
      to,
    ]);
  }
  return out;
}

function curveCommands(points: readonly Point[]): string {
  return segments(points)
    .map(([, c1, c2, to]) => `C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${r(to[0])} ${r(to[1])}`)
    .join("");
}

/** Points along the smooth curve through `points`, `perSegment` to each stretch. */
export function sample(points: readonly Point[], perSegment = 14): Point[] {
  const out: Point[] = [];
  for (const [a, b, c, d] of segments(points)) {
    for (let k = 0; k < perSegment; k += 1) {
      const t = k / perSegment;
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

export function polyline(points: readonly Point[]): string {
  return `M${points.map((p) => `${r(p[0])} ${r(p[1])}`).join("L")}`;
}

/** Everything under a ridge line, closed along `bottom`. */
export function landBelow(ridge: readonly Point[], bottom: number): string {
  const first = ridge[0];
  const last = ridge[ridge.length - 1];
  return `M${r(first[0])} ${r(bottom)}L${r(first[0])} ${r(first[1])}${curveCommands(ridge)}L${r(last[0])} ${r(bottom)}Z`;
}

/** A road seen in perspective: a band along the curve that narrows from `nearWidth` to `farWidth`. */
export function ribbon(points: readonly Point[], nearWidth: number, farWidth: number): string {
  const path = sample(points, 16);
  const count = path.length;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(count - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    const half = (nearWidth + (farWidth - nearWidth) * Math.pow(i / (count - 1), 0.85)) / 2;
    const nx = (-dy / length) * half;
    const ny = (dx / length) * half * 0.42;
    left.push(`${r(path[i][0] + nx)} ${r(path[i][1] + ny)}`);
    right.push(`${r(path[i][0] - nx)} ${r(path[i][1] - ny)}`);
  }
  return `M${left.join("L")}L${right.reverse().join("L")}Z`;
}

export function mixHex(from: string, to: string, amount: number): string {
  const channel = (offset: number) =>
    Math.round(
      parseInt(from.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(to.slice(offset, offset + 2), 16) * amount,
    )
      .toString(16)
      .padStart(2, "0");
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** The twenty bytes of an Ethereum address; a malformed one yields an even, featureless range. */
export function addressBytes(address: string | undefined): number[] {
  const hex = address?.replace(/^0x/i, "") ?? "";
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) return Array.from({ length: 20 }, (_, i) => 96 + ((i * 53) % 96));
  return Array.from({ length: 20 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** The 56 base-32 digits of a Stellar address, each 0–31. */
export function strkeyDigits(address: string | undefined): number[] {
  const digits = [...(address ?? "")].map((char) => BASE32.indexOf(char));
  if (digits.length !== 56 || digits.some((digit) => digit < 0)) {
    return Array.from({ length: 56 }, (_, i) => 6 + ((i * 11) % 20));
  }
  return digits;
}
