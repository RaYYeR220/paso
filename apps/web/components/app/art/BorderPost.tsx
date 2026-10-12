const STRIPES = [10, 34, 58, 82, 106, 130];

/**
 * The border post. Its boom is raised while the road is open and drops across
 * it when a call is refused; the colours and the angle come from the verdict
 * it sits in.
 */
export function BorderPost() {
  return (
    <svg className="post" viewBox="0 0 220 82" aria-hidden="true" focusable="false">
      <path className="post-hill" d="M0 82C30 56 74 34 120 30C160 27 196 38 220 52L220 82Z" />
      <path className="post-road" d="M84 82L196 82L150 26L138 26Z" />
      <path className="post-centre" d="M141 78L144 32" />
      <rect className="post-catch" x={196} y={52} width={8} height={30} />
      <rect className="post-catch" x={190} y={47} width={20} height={6} />
      <rect className="post-pillar" x={52} y={44} width={14} height={38} />
      <rect className="post-cap" x={52} y={44} width={14} height={9} />
      <g transform="translate(59 56)">
        <g className="boom">
          <rect className="boom-weight" x={-26} y={-11} width={24} height={22} />
          <rect className="boom-bar" x={-2} y={-7.5} width={144} height={15} />
          {STRIPES.map((x) => (
            <rect key={x} className="boom-stripe" x={x} y={-7.5} width={12} height={15} />
          ))}
          <rect className="boom-edge" x={-2} y={-7.5} width={144} height={15} />
        </g>
      </g>
    </svg>
  );
}
