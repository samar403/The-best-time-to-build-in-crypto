/** The Clearance mark: a radar scope with its sweep, closing on a tick. */
export function Glyph({ size = 26 }: { size?: number }) {
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.45" />
      <circle cx="16" cy="16" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.3" />
      <path className="glyph-sweep" d="M16 16 L16 3 A13 13 0 0 1 27.3 9.5 Z" fill="currentColor" opacity="0.9" />
      <circle cx="16" cy="16" r="2" fill="currentColor" />
    </svg>
  );
}

/** Deterministic identicon from a key fingerprint — every agent gets a face. */
export function Identicon({ seed, size = 56 }: { seed: string; size?: number }) {
  const hex = seed.replace(/[^0-9a-f]/gi, "").toLowerCase().padEnd(32, "0");
  const cells: boolean[] = [];
  for (let i = 0; i < 15; i++) cells.push(parseInt(hex[i], 16) % 2 === 0);
  const hue = parseInt(hex.slice(15, 18), 16) % 360;
  const rects = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const col = x < 3 ? x : 4 - x;
      if (cells[y * 3 + col]) rects.push(<rect key={`${x}-${y}`} x={x * 6 + 1} y={y * 6 + 1} width="5" height="5" rx="1" />);
    }
  }
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="identicon" aria-hidden="true">
      <rect width="32" height="32" rx="4" fill={`hsl(${hue} 30% 16%)`} />
      <g fill={`hsl(${hue} 80% 70%)`}>{rects}</g>
    </svg>
  );
}
