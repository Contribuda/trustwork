/**
 * Accepts only same-origin relative paths for `?next=`: a single leading slash, no second slash or
 * backslash (Chromium normalises `/\evil` to `//evil`), no whitespace, and no percent-encoded
 * backslash or slash that could decode into one of those. Everything else falls back to `/app`.
 */
export function safeNext(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\/(?![/\\])[^\s\\]*$/.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (/[\\\s]/.test(decoded) || decoded.startsWith('//')) return null;
  return raw;
}
