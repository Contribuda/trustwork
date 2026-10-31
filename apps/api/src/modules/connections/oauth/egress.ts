import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Egress guard for Client ID Metadata Documents (ADR 013 decision 6; SSRF protections of the CIMD draft and the MCP
 * security best practices). A client id URL is fetched only when:
 * - it is `https:` on the default port, with no credentials and no fragment;
 * - every address its host resolves to is public (private, loopback, link-local, carrier-grade NAT, documentation,
 *   benchmarking, multicast, reserved, unique-local and the IPv4-mapped / NAT64 / 6to4 / Teredo forms of those are
 *   refused, so one private answer refuses the whole host);
 * - the connection goes to exactly the address that was checked (the transport pins it, so a second DNS answer cannot
 *   rebind the request), with TLS verified against the host name;
 * - the answer is a 200 JSON document within the size and time limits; redirects are never followed.
 * The guard runs before the transport is called: a refused URL never reaches the network.
 */
export type EgressRefusal = 'invalid_url' | 'not_https' | 'credentials_in_url' | 'port_not_allowed' | 'private_address' | 'unresolvable' | 'redirect'
  | 'bad_status' | 'too_large' | 'timeout' | 'not_json' | 'transport_error';
export class EgressRefused extends Error {
  constructor(readonly reason: EgressRefusal) {
    super(`client metadata fetch refused: ${reason}`);
    this.name = 'EgressRefused';
  }
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['::', 96], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(net, prefix, 'ipv6');

function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase().split('%')[0] ?? '';
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const o = v4.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return null;
    text = `${text.slice(0, v4.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : []);
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}
const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** True when the address is a public unicast address the egress guard may connect to. */
export function addressAllowed(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family !== 6) return false;
  const g = expandIpv6(address);
  if (!g) return false;
  // Embedded IPv4 forms are judged by the IPv4 address they carry.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0xffff ? addressAllowed(v4From(g[6]!, g[7]!)) : false;
  if (g[0] === 0x64 && g[1] === 0xff9b) return addressAllowed(v4From(g[6]!, g[7]!));
  if (g[0] === 0x2002) return addressAllowed(v4From(g[1]!, g[2]!));
  if (g[0] === 0x2001 && g[1] === 0) return false;
  return !BLOCKED.check(address.split('%')[0]!, 'ipv6');
}

export interface ResolvedAddress { address: string; family: 4 | 6 }
export interface DnsResolver { resolve(host: string): Promise<ResolvedAddress[]> }
export interface TransportResponse { status: number; headers: Record<string, string>; body: Buffer }
export interface TransportRequest { url: URL; address: ResolvedAddress; timeoutMs: number; maxBytes: number }
export interface EgressTransport { get(request: TransportRequest): Promise<TransportResponse> }
export interface EgressLimits { timeoutMs: number; maxBytes: number }
export const DEFAULT_EGRESS_LIMITS: EgressLimits = { timeoutMs: 5_000, maxBytes: 10 * 1024 };

export interface FetchedDocument { document: unknown; body: Buffer; headers: Record<string, string> }

/** Validates the URL and every resolved address, then fetches through the pinned transport. */
export class GuardedFetcher {
  constructor(private readonly dns: DnsResolver, private readonly transport: EgressTransport, private readonly limits: EgressLimits = DEFAULT_EGRESS_LIMITS) {}

  async fetchJson(raw: string): Promise<FetchedDocument> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EgressRefused('invalid_url');
    }
    if (url.protocol !== 'https:') throw new EgressRefused('not_https');
    if (url.username || url.password) throw new EgressRefused('credentials_in_url');
    if (url.port !== '' && url.port !== '443') throw new EgressRefused('port_not_allowed');
    if (url.hash) throw new EgressRefused('invalid_url');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: ResolvedAddress[];
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) as 4 | 6 }];
    else {
      if (!/^[a-z0-9.-]+$/i.test(host) || /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(host)) throw new EgressRefused('private_address');
      try {
        addresses = await this.dns.resolve(host);
      } catch {
        throw new EgressRefused('unresolvable');
      }
    }
    if (!addresses.length) throw new EgressRefused('unresolvable');
    if (addresses.some((a) => !addressAllowed(a.address))) throw new EgressRefused('private_address');
    let response: TransportResponse;
    try {
      response = await this.transport.get({ url, address: addresses[0]!, timeoutMs: this.limits.timeoutMs, maxBytes: this.limits.maxBytes });
    } catch (error) {
      if (error instanceof EgressRefused) throw error;
      throw new EgressRefused('transport_error');
    }
    if (response.status >= 300 && response.status < 400) throw new EgressRefused('redirect');
    if (response.status !== 200) throw new EgressRefused('bad_status');
    if (response.body.length > this.limits.maxBytes) throw new EgressRefused('too_large');
    const type = (response.headers['content-type'] ?? '').toLowerCase();
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json\b/.test(type)) throw new EgressRefused('not_json');
    try {
      return { document: JSON.parse(response.body.toString('utf8')), body: response.body, headers: response.headers };
    } catch {
      throw new EgressRefused('not_json');
    }
  }
}

/** System resolver: every A and AAAA answer, so the guard can refuse a host with any private answer. */
export const systemResolver: DnsResolver = {
  async resolve(host) {
    const answers = await lookup(host, { all: true, verbatim: true });
    return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
  },
};

/** HTTPS GET to exactly the checked address (no second DNS lookup), certificate checked for the host name, no redirects. */
export const pinnedHttpsTransport: EgressTransport = {
  get({ url, address, timeoutMs, maxBytes }) {
    return new Promise((resolve, reject) => {
      const req = httpsRequest({
        host: url.hostname.replace(/^\[|\]$/g, ''), servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname, port: 443, method: 'GET',
        path: `${url.pathname}${url.search}`, agent: false, timeout: timeoutMs,
        headers: { accept: 'application/json', 'user-agent': 'Trustwork-AuthorizationServer/1.0' },
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new EgressRefused('too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      });
      const deadline = setTimeout(() => req.destroy(new EgressRefused('timeout')), timeoutMs);
      req.on('timeout', () => req.destroy(new EgressRefused('timeout')));
      req.on('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      req.on('close', () => clearTimeout(deadline));
      req.end();
    });
  },
};

/** Scriptable resolver and transport for tests and `fake` mode; the transport records every request it receives. */
export class FakeDns implements DnsResolver {
  readonly answers = new Map<string, ResolvedAddress[]>();
  set(host: string, ...addresses: string[]): void {
    this.answers.set(host, addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 })));
  }
  async resolve(host: string): Promise<ResolvedAddress[]> {
    const found = this.answers.get(host);
    if (!found) throw new Error('ENOTFOUND');
    return found;
  }
}
export class FakeTransport implements EgressTransport {
  readonly documents = new Map<string, TransportResponse>();
  readonly requests: TransportRequest[] = [];
  serve(url: string, document: unknown, headers: Record<string, string> = {}, status = 200): void {
    this.documents.set(url, { status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(typeof document === 'string' ? document : JSON.stringify(document)) });
  }
  async get(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const found = this.documents.get(request.url.toString());
    if (!found) return { status: 404, headers: {}, body: Buffer.alloc(0) };
    return found;
  }
}
