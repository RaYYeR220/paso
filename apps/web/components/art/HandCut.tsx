/**
 * The hand-cut edge every shape in the poster shares: a slight displacement,
 * as if the gouache were laid down against torn paper. Define it once inside
 * an <svg>, then set `filter="url(#id)"` on any group.
 */
export function HandCutFilter({ id, x, y, width, height }: { id: string; x: number; y: number; width: number; height: number }) {
  return (
    <filter id={id} filterUnits="userSpaceOnUse" x={x} y={y} width={width} height={height}>
      <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="9" result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
}
