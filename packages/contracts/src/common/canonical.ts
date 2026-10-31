/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) in pure TypeScript.
 *
 * - object keys sorted by UTF-16 code units (ECMAScript default string comparison);
 * - string escaping identical to ECMAScript `JSON.stringify`;
 * - numbers serialized with ECMAScript `Number::toString` (I-JSON: finite only; integers are the only
 *   numbers in digest inputs of this product, every money/quantity value is a string);
 * - no whitespace, no Unicode normalization (NFC is applied earlier at input validation).
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

export class CanonicalizationError extends Error {
  readonly code = 'validation.not_canonicalizable' as const;
}

export function canonicalize(value: unknown): string {
  const parts: string[] = [];
  write(value, parts, '$');
  return parts.join('');
}
function write(value: unknown, out: string[], path: string): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError(`non-finite number at ${path}`);
      out.push(JSON.stringify(value));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'bigint':
    case 'symbol':
    case 'function':
    case 'undefined':
      throw new CanonicalizationError(`unsupported ${typeof value} at ${path}`);
    case 'object':
      break;
  }
  if (Array.isArray(value)) {
    out.push('[');
    value.forEach((item, index) => {
      if (index) out.push(',');
      // JSON.stringify maps undefined array items to null; JCS inputs must be explicit, so reject.
      if (item === undefined) throw new CanonicalizationError(`undefined array item at ${path}[${index}]`);
      write(item, out, `${path}[${index}]`);
    });
    out.push(']');
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new CanonicalizationError(`non-plain object at ${path}`);
  const record = value as Record<string, unknown>;
  // Default Array.prototype.sort compares UTF-16 code units, which is exactly the JCS order.
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  out.push('{');
  keys.forEach((key, index) => {
    if (index) out.push(',');
    out.push(JSON.stringify(key), ':');
    write(record[key], out, `${path}.${key}`);
  });
  out.push('}');
}

/** UTF-8 bytes of the canonical form; the digest input of `trustwork-digest-1`. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
