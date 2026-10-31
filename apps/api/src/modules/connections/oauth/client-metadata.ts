import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Client registration documents: Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document) and the
 * deprecated dynamic registration request (RFC 7591). Both describe public clients in this release (token endpoint
 * method `none`); a document that carries a client secret is refused. Redirect URIs are `https:` without a fragment,
 * or, for native clients, an `http:` loopback address (RFC 8252 section 7.3; any port matches at authorization time).
 */
export interface ClientDescription {
  clientName: string;
  clientUri: string | null;
  redirectUris: string[];
  applicationType: 'web' | 'native';
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d{1,5})?(\/[^#\s]*)?$/;

export function redirectUriAllowed(uri: string, applicationType: 'web' | 'native'): boolean {
  if (uri.length > 500 || /\s/.test(uri)) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return applicationType === 'native' && LOOPBACK.test(uri);
}

/** RFC 8252 section 7.3: a registered loopback URI matches any port; everything else matches exactly. Mirrors the SQL helper. */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  const strip = (u: string) => u.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost))(:\d{1,5})?/, '$1');
  return LOOPBACK.test(registered) && LOOPBACK.test(presented) && strip(registered) === strip(presented);
}
export function isLoopbackRedirect(uri: string): boolean {
  return LOOPBACK.test(uri);
}

const SECRET_FIELDS = ['client_secret', 'client_secret_expires_at'];
const Description = z.object({
  client_name: z.string().trim().min(1).max(120).optional(),
  client_uri: z.url({ protocol: /^https$/ }).max(500).optional(),
  redirect_uris: z.array(z.string()).min(1).max(20),
  application_type: z.enum(['web', 'native']).optional(),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

export class ClientDocumentError extends Error {
  constructor(readonly description: string) {
    super(description);
    this.name = 'ClientDocumentError';
  }
}

function describe(raw: unknown, fallbackName: string, applicationTypeRequired: boolean): ClientDescription {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ClientDocumentError('the client document is not a JSON object');
  for (const field of SECRET_FIELDS) if (field in raw) throw new ClientDocumentError('public clients carry no client secret');
  const parsed = Description.safeParse(raw);
  if (!parsed.success) throw new ClientDocumentError(`invalid client document: ${parsed.error.issues[0]?.path.join('.') ?? 'document'}`);
  const d = parsed.data;
  if (applicationTypeRequired && !d.application_type) throw new ClientDocumentError('application_type is required');
  const applicationType = d.application_type ?? 'web';
  if (d.grant_types && d.grant_types.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) throw new ClientDocumentError('only authorization_code and refresh_token grants');
  if (d.response_types && d.response_types.some((r) => r !== 'code')) throw new ClientDocumentError('only the code response type');
  if (new Set(d.redirect_uris).size !== d.redirect_uris.length) throw new ClientDocumentError('redirect URIs are distinct');
  for (const uri of d.redirect_uris) if (!redirectUriAllowed(uri, applicationType)) throw new ClientDocumentError('a redirect URI is not allowed');
  return { clientName: d.client_name ?? fallbackName, clientUri: d.client_uri ?? null, redirectUris: d.redirect_uris, applicationType };
}

/** A Client ID Metadata Document: its `client_id` must equal the URL it was fetched from. */
export function parseClientMetadataDocument(clientId: string, document: unknown): ClientDescription {
  if (!document || typeof document !== 'object' || (document as { client_id?: unknown }).client_id !== clientId) throw new ClientDocumentError('client_id of the document differs from its URL');
  return describe(document, new URL(clientId).host, false);
}

/** A dynamic registration request (RFC 7591; `application_type` required by the hub). */
export function parseRegistrationRequest(body: unknown): ClientDescription {
  return describe(body, 'Unnamed client', true);
}

/** A URL client id per the draft: https, a path, no fragment, no credentials, no dot segments. */
export function isMetadataClientId(clientId: string): boolean {
  if (!clientId.startsWith('https://') || clientId.length > 500) return false;
  try {
    const url = new URL(clientId);
    return url.pathname.length > 1 && !url.hash && !url.username && !url.password && url.toString() === clientId && !/\/\.\.?(\/|$)/.test(clientId.slice(8));
  } catch {
    return false;
  }
}

/** Cache lifetime from `Cache-Control` (max-age, clamped to 60 seconds .. 24 hours; no-store or no-cache: the minimum; absent: one hour). */
export function cacheSeconds(cacheControl: string | undefined): number {
  const value = (cacheControl ?? '').toLowerCase();
  if (/\bno-store\b|\bno-cache\b/.test(value)) return 60;
  const maxAge = /\bmax-age=(\d+)/.exec(value);
  const seconds = maxAge ? Number(maxAge[1]) : 3600;
  return Math.min(Math.max(seconds, 60), 86_400);
}

export const documentDigest = (body: Buffer): string => createHash('sha256').update(body).digest('hex');
