/** Joins class names, skipping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Removes keys whose value is `undefined` so spreads satisfy exactOptionalPropertyTypes. */
export function defined<T extends object>(object: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}
