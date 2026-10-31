import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for S3-compatible object storage (header authorization and presigned query strings), on
 * node:crypto alone: no SDK dependency. Verified against the published AWS examples in tests/files/sigv4.test.ts.
 */
export interface SigV4Credentials { accessKeyId: string; secretAccessKey: string; region: string; service?: string }
export interface SigV4Request {
  method: string;
  /** Absolute URL without the signature parameters; its host header is signed. */
  url: URL;
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash?: string;
}

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as S3 expects it: unreserved characters stay, everything else is %XX (upper case). */
export function uriEncode(value: string, keepSlash = false): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === '/')) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function amzDate(at: Date): { dateTime: string; date: string } {
  const dateTime = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { dateTime, date: dateTime.slice(0, 8) };
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  url.searchParams.forEach((value, key) => pairs.push([uriEncode(key), uriEncode(value)]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function canonicalHeaders(url: URL, headers: Record<string, string>): { canonical: string; signed: string } {
  const all = new Map<string, string>([['host', url.host]]);
  for (const [name, value] of Object.entries(headers)) all.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
  const names = [...all.keys()].sort();
  return { canonical: names.map((n) => `${n}:${all.get(n)}\n`).join(''), signed: names.join(';') };
}

function signingKey(credentials: SigV4Credentials, date: string): Buffer {
  const service = credentials.service ?? 's3';
  return hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), credentials.region), service), 'aws4_request');
}

function stringToSign(credentials: SigV4Credentials, dateTime: string, date: string, canonicalRequest: string): string {
  const scope = `${date}/${credentials.region}/${credentials.service ?? 's3'}/aws4_request`;
  return ['AWS4-HMAC-SHA256', dateTime, scope, sha256Hex(canonicalRequest)].join('\n');
}

/** The canonical request of the specification (exposed for tests). */
export function canonicalRequest(request: SigV4Request, signedHeaders: Record<string, string>): string {
  const { canonical, signed } = canonicalHeaders(request.url, signedHeaders);
  const path = request.url.pathname === '' ? '/' : request.url.pathname;
  return [request.method.toUpperCase(), uriEncode(decodeURIComponent(path), true), canonicalQuery(request.url), canonical, signed, request.payloadHash ?? UNSIGNED_PAYLOAD].join('\n');
}

/** Header authorization: returns the headers to send (x-amz-date, x-amz-content-sha256, authorization). */
export function signHeaders(credentials: SigV4Credentials, request: SigV4Request, at: Date): Record<string, string> {
  const { dateTime, date } = amzDate(at);
  const payloadHash = request.payloadHash ?? UNSIGNED_PAYLOAD;
  const headers: Record<string, string> = { ...(request.headers ?? {}), 'x-amz-date': dateTime, 'x-amz-content-sha256': payloadHash };
  const creq = canonicalRequest({ ...request, payloadHash }, headers);
  const signature = createHmac('sha256', signingKey(credentials, date)).update(stringToSign(credentials, dateTime, date, creq), 'utf8').digest('hex');
  const signed = canonicalHeaders(request.url, headers).signed;
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${date}/${credentials.region}/${credentials.service ?? 's3'}/aws4_request, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

/**
 * Presigned URL (query authorization). `headers` are signed too: the client must send exactly these values (for an
 * upload: the content type and length the API accepted). The payload is unsigned; the worker verifies the stored bytes.
 */
export function presignUrl(credentials: SigV4Credentials, request: SigV4Request, at: Date, expiresInSeconds: number): URL {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604_800) throw new RangeError('presigned URL lifetime must be 1..604800 seconds');
  const { dateTime, date } = amzDate(at);
  const headers = request.headers ?? {};
  const url = new URL(request.url.toString());
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${credentials.accessKeyId}/${date}/${credentials.region}/${credentials.service ?? 's3'}/aws4_request`);
  url.searchParams.set('X-Amz-Date', dateTime);
  url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', canonicalHeaders(url, headers).signed);
  const creq = canonicalRequest({ method: request.method, url, payloadHash: UNSIGNED_PAYLOAD }, headers);
  const signature = createHmac('sha256', signingKey(credentials, date)).update(stringToSign(credentials, dateTime, date, creq), 'utf8').digest('hex');
  url.searchParams.set('X-Amz-Signature', signature);
  // URLSearchParams encodes spaces as '+'; S3 reads '+' as a plus sign, so re-encode the query with %20.
  url.search = [...url.searchParams].map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
  return url;
}

export { sha256Hex };
