/** Deterministic monogram tile for a company without an uploaded logo: two letters on one of four brand tints. */
const TINTS = ['co-mark--blue', 'co-mark--navy', 'co-mark--teal', 'co-mark--amber'];

/** Two letters used by the mark tile and the map pin, so both read as the same company. */
export function initials(name: string): string {
  const clean = name
    .replace(/\(.*?\)/g, '')
    .replace(/[«»"]/g, '')
    .trim();
  const words = clean.split(/[\s-]+/).filter((w) => w.length > 1 && !/^(ооо|ао|пао|зао|ип|бюро)$/i.test(w));
  const first = words[0]?.[0] ?? clean[0] ?? '?';
  const second = words[1]?.[0] ?? words[0]?.[1] ?? '';
  return (first + second).toUpperCase();
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function CompanyMark({ name, seed, size = 48 }: { name: string; seed: string; size?: number }) {
  const tint = TINTS[hash(seed) % TINTS.length];
  return (
    <span className={`co-mark ${tint}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
