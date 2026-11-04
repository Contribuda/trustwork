import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { MANIFEST_PATH, MESH_ENDPOINTS, NodeHostSchema } from './deps.js';
import type { SignedFields } from './http-signatures.js';

/**
 * How this node reaches a peer (FED-001). The port hides the network so tests run against a local fake, and it splits
 * every exchange in two steps so that no restricted place is ever contacted:
 *
 * 1. `resolve(host)` answers the server address the peer's DNS name resolves to, without connecting. The service judges
 *    that address through the jurisdiction gate (SANC-008 observed evidence) and refuses before any connection.
 * 2. `fetchManifest` and `postHandshake` connect to **that same address** (TLS server name and certificate checks stay
 *    on the DNS name), so the address judged is the address connected to.
 *
 * Bodies are read up to `MAX_PEER_BODY` and no further; redirects are never followed. The address is used for the lookup
 * and the connection and dropped: it is never stored, logged or echoed.
 */
export interface PeerResponse {
  status: number;
  /** Lowercase header lookup. */
  header(name: string): string | null;
  /** The exact body bytes (at most MAX_PEER_BODY). */
  body: Uint8Array;
  /** The server address connected to, for the admission check's observed evidence; null when unknown. */
  remoteAddress: string | null;
}
export interface PeerTransport {
  /** The server address the peer's name resolves to, or null when it does not resolve. Never connects. */
  resolve(host: string): Promise<string | null>;
  fetchManifest(host: string, address: string): Promise<PeerResponse>;
  postHandshake(host: string, address: string, body: Uint8Array, fields: SignedFields): Promise<PeerResponse>;
}

export class PeerUnreachableError extends Error {
  constructor(readonly host: string, cause?: unknown) {
    super(`peer unreachable: ${host}`);
    this.name = 'PeerUnreachableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** The most a peer's manifest or answer may weigh (the canonical payload limit of the protocol). */
export const MAX_PEER_BODY = 256 * 1024;

/** The production transport over `node:https`, pinned to the resolved address; refuses anything that is not a DNS name. */
export class HttpsPeerTransport implements PeerTransport {
  constructor(private readonly timeoutMs = 10_000) {}

  async resolve(host: string): Promise<string | null> {
    if (!NodeHostSchema.safeParse(host).success) throw new PeerUnreachableError(host);
    try {
      return (await lookup(host)).address;
    } catch {
      return null;
    }
  }

  private request(host: string, address: string, path: string, method: 'GET' | 'POST', headers: Record<string, string>, body: Uint8Array | null): Promise<PeerResponse> {
    if (!NodeHostSchema.safeParse(host).success || !isIP(address)) return Promise.reject(new PeerUnreachableError(host));
    return new Promise<PeerResponse>((resolve, reject) => {
      const req = httpsRequest({
        host: address, servername: host, port: 443, path, method, timeout: this.timeoutMs,
        headers: { ...headers, host, accept: 'application/json', ...(body ? { 'content-length': String(body.length) } : {}) },
        // The connection goes to the judged address and nowhere else; the certificate is still checked against the name.
        lookup: (_hostname, _options, callback) => (callback as (err: Error | null, address: string, family: number) => void)(null, address, isIP(address)),
      }, (response) => {
        const declared = Number(response.headers['content-length'] ?? '0');
        if (declared > MAX_PEER_BODY) {
          response.destroy();
          reject(new PeerUnreachableError(host, new Error('body too large')));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PEER_BODY) {
            response.destroy();
            reject(new PeerUnreachableError(host, new Error('body too large')));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const lower = new Map(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] ?? null : v ?? null]));
          resolve({ status: response.statusCode ?? 0, header: (name) => lower.get(name.toLowerCase()) ?? null, body: new Uint8Array(Buffer.concat(chunks)), remoteAddress: address });
        });
        response.on('error', (error) => reject(new PeerUnreachableError(host, error)));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (error) => reject(new PeerUnreachableError(host, error)));
      if (body) req.write(Buffer.from(body));
      req.end();
    });
  }
  fetchManifest(host: string, address: string): Promise<PeerResponse> {
    return this.request(host, address, MANIFEST_PATH, 'GET', {}, null);
  }
  postHandshake(host: string, address: string, body: Uint8Array, fields: SignedFields): Promise<PeerResponse> {
    return this.request(host, address, MESH_ENDPOINTS.handshake, 'POST', { ...fields }, body);
  }
}

/**
 * No network at all: every call fails as unreachable. The default outside production (and in every test), so a
 * development or test process never resolves or contacts a peer unless `TRUSTWORK_FEDERATION_TRANSPORT=https` says so.
 */
export class OfflinePeerTransport implements PeerTransport {
  async resolve(host: string): Promise<string | null> {
    throw new PeerUnreachableError(host, new Error('federation transport is offline'));
  }
  async fetchManifest(host: string): Promise<PeerResponse> {
    throw new PeerUnreachableError(host, new Error('federation transport is offline'));
  }
  async postHandshake(host: string): Promise<PeerResponse> {
    throw new PeerUnreachableError(host, new Error('federation transport is offline'));
  }
}
