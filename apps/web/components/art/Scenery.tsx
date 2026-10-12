import { round } from "./geometry";

type Placed = { x: number; y: number; scale?: number };

const place = ({ x, y, scale = 1 }: Placed) => `translate(${round(x)} ${round(y)}) scale(${scale})`;

/** An araucaria, rooted at (x, y). Takes its colour from the surrounding `fill`. */
export function Tree(props: Placed) {
  return (
    <g transform={place(props)}>
      <path d="M-3.2 2L-1.7 -84L1.7 -84L3.2 2Z" />
      <path d="M-36 -66C-32 -90-13 -102 0 -102C13 -102 32 -90 36 -66C27 -75 19 -77 12 -72C7 -79-7 -79-12 -72C-19 -77-27 -75-36 -66Z" />
      <path d="M-25 -47C-22 -63-9 -70 0 -70C9 -70 22 -63 25 -47C18 -54 12 -56 8 -52C4 -57-4 -57-8 -52C-12 -56-18 -54-25 -47Z" />
      <path d="M-16 -31C-14 -42-6 -46 0 -46C6 -46 14 -42 16 -31C11 -36 6 -37 0 -34C-6 -37-11 -36-16 -31Z" />
    </g>
  );
}

/** A condor in silhouette, centred on (x, y). */
export function Bird(props: Placed) {
  return (
    <path
      transform={place(props)}
      d="M0 0C9 -7 22 -11 40 -6C30 -6 21 -2 13 3C8 6 4 6 0 3C-4 6-8 6-13 3C-21 -2-30 -6-40 -6C-22 -11-9 -7 0 0Z"
    />
  );
}

/** A stack of flat cloud bars, its long bar starting at (x, y). */
export function Cloud(props: Placed) {
  return (
    <g transform={place(props)}>
      <rect x="0" y="0" width="210" height="20" rx="10" />
      <rect x="46" y="-25" width="118" height="20" rx="10" />
      <rect x="-44" y="25" width="150" height="15" rx="7.5" />
      <rect x="128" y="25" width="60" height="15" rx="7.5" />
    </g>
  );
}
