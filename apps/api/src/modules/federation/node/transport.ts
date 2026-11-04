import { lookup } from 'node:dns/promises';
import { MANIFEST_PATH, MESH_ENDPOINTS, NodeHostSchema } from './deps.js';
import type { SignedFields } from './http-signatures.js';

/**
 * How this node reaches a peer (FED-001). The port hides the network so tests run against a local fake; the HTTPS
 * adapter talks only to `https://<DNS name>` on port 443 and reports the address it resolved the name to, which is the
 * only "observed" evidence an initiator has about a peer's server. The address is used for the admission lookup and
 * dropped: it is never stored, logged or echoed.
 */
export interface PeerResponse {
  status: number;
  /** Lowercase header lookup. */
  header(name: string): string | null;
  /** The exact body bytes. */
  body: Uint8Array;
  /** The resolved server address of the peer, for the admission check's observed evidence; null when unknown. */
  remoteAddress: string | null;
}
export interface PeerTransport {
  fetchManifest(host: string): Promise<PeerResponse>;
  postHandshake(host: string, body: Uint8Array, fields: SignedFields): Promise<PeerResponse>;
}

export class PeerUnreachableError extends Error {
  constructor(readonly host: string, cause?: unknown) {
    super(`peer unreachable: ${host}`);
    this.name = 'PeerUnreachableError';
    if (cause !== undefined) this.cause = cause;
  }
}

const MAX_BODY = 512 * 1024;

/** The production transport over the global fetch; refuses anything that is not a DNS name. */
export class HttpsPeerTransport implements PeerTransport {
  constructor(private readonly fetchFn: typeof fetch = fetch, private readonly timeoutMs = 10_000) {}

  private async request(host: string, path: string, init: RequestInit): Promise<PeerResponse> {
    if (!NodeHostSchema.safeParse(host).success) throw new PeerUnreachableError(host);
    let remoteAddress: string | null = null;
    try {
      remoteAddress = (await lookup(host)).address;
    } catch (error) {
      throw new PeerUnreachableError(host, error);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`https://${host}${path}`, { ...init, redirect: 'error', signal: controller.signal });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_BODY) throw new PeerUnreachableError(host, new Error('body too large'));
      return { status: response.status, header: (name) => response.headers.get(name), body: bytes, remoteAddress };
    } catch (error) {
      if (error instanceof PeerUnreachableError) throw error;
      throw new PeerUnreachableError(host, error);
    } finally {
      clearTimeout(timer);
    }
  }
  fetchManifest(host: string): Promise<PeerResponse> {
    return this.request(host, MANIFEST_PATH, { method: 'GET', headers: { accept: 'application/json' } });
  }
  postHandshake(host: string, body: Uint8Array, fields: SignedFields): Promise<PeerResponse> {
    return this.request(host, MESH_ENDPOINTS.handshake, { method: 'POST', headers: { ...fields, accept: 'application/json' } as Record<string, string>, body: Buffer.from(body) });
  }
}

/**
 * No network at all: every call fails as unreachable. The default outside production (and in every test), so a
 * development or test process never resolves or contacts a peer unless `TRUSTWORK_FEDERATION_TRANSPORT=https` says so.
 */
export class OfflinePeerTransport implements PeerTransport {
  async fetchManifest(host: string): Promise<PeerResponse> {
    throw new PeerUnreachableError(host, new Error('federation transport is offline'));
  }
  async postHandshake(host: string): Promise<PeerResponse> {
    throw new PeerUnreachableError(host, new Error('federation transport is offline'));
  }
}
