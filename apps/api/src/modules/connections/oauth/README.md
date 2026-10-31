# Connections: the hub authorization server (MCP-002)

Status: **Live in the API** (tests on a real PostgreSQL); the MCP transport that consumes the tokens is MCP-003 and the consent and connection screens are MCP-070. Design: [ADR 013](../../../../../../docs/adr/013-mcp-server.md) decisions 5 to 9 and [The MCP server](../../../../../../docs/engine/mcp-server.md#connecting-and-authorization). Data: `packages/data/migrations/connections/`, `packages/data/src/schema/connections.ts`, `packages/data/src/repositories/connections.ts`.

A connection is another hand of the person's one agent. It holds the person's consent for one client id, one redirect URI and one surface (`/mcp` or `/mcp/admin`); every token references it, and the grant (scopes, toolsets, private data classes, mandate bindings) is read from the live consent on every token check.

## Endpoints

| Path | Who calls it | What it does |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | MCP clients | RFC 8414 metadata: one issuer (the hub origin), `code_challenge_methods_supported: ["S256"]`, `authorization_response_iss_parameter_supported: true`, `token_endpoint_auth_methods_supported: ["none", "private_key_jwt"]`, `client_id_metadata_document_supported` (true unless metadata fetching is disabled), revocation and (when the hub allows it) registration endpoints, DPoP algorithms |
| `GET /.well-known/oauth-protected-resource/mcp`, `.../mcp/admin` | MCP clients | RFC 9728 metadata per surface; `authorization_servers` has exactly one entry; the admin document answers 404 while the admin surface is off (the default) |
| `GET /v1/oauth/authorize` | The person's browser | Validates the client (metadata document through the egress guard, or a stored registration) and the redirect URI first (errors there never redirect), then PKCE S256, exactly one `resource` equal to a surface's canonical URI, and the scopes. Without a session it redirects to `/login?next=/oauth/consent?request=…`; with a session to `/oauth/consent?request=…`, except when a participant consent is still in force for exactly this client, redirect URI and scopes (then it answers with the code). Every redirect to the client carries `iss`; responses carry `frame-ancestors 'none'`, `X-Frame-Options: DENY` and `no-store` |
| `GET /v1/oauth/requests?request=` | The consent page (MCP-070) | What to show: client name (self-asserted unless the hub lists the client), client id host, redirect host, loopback-only warning, requested scopes, toolsets, private data classes, whether mandate bindings are needed, consent expiry, rate limits and the consent in force |
| `POST /v1/oauth/requests/decision` | The consent page | Session with a fresh step-up, same-origin CSRF proof; staff (`/mcp/admin`) also need a live elevated session. Grants a subset of the requested scopes (never more), toolsets, private classes one by one (`read.private`), and mandate bindings (required exactly with `act`, each an active mandate of the person at its current revision). Returns `redirectTo` (code, state, iss, or `access_denied`) |
| `POST /v1/oauth/token` | MCP clients (no session) | `application/x-www-form-urlencoded` only. `authorization_code` (code, `redirect_uri`, `code_verifier`, `resource`) and `refresh_token`. Public clients authenticate with `client_id`; pre-registered confidential clients with `private_key_jwt`. Issues 15-minute opaque access tokens bound to one audience and rotating refresh tokens; a `DPoP` proof binds the whole family to its key |
| `POST /v1/oauth/revoke` | MCP clients | RFC 7009; a refresh token ends its family, an access token ends itself; answers 200 whatever happened |
| `POST /v1/oauth/register` | MCP clients | Deprecated RFC 7591 dynamic registration behind `MCP_DYNAMIC_REGISTRATION` (default on): public clients only, `application_type` required, rate-limited per address; unused registrations are deleted after 30 days |
| `GET /v1/oauth/connections`, `POST /v1/oauth/connections/:id/revoke`, `POST /v1/oauth/connections/revoke-all` | Settings, Connections (MCP-070) | The person's connections; revocation withdraws the consent and revokes every token before the next call |

`ResourceTokenVerifier` and `mcpResourceHook(verifier, surface)` (in `resource.ts`) are the resource server's check for MCP-003: only the `Authorization` header counts (`Bearer`, or `DPoP` with a proof whose `ath`, `htm` and `htu` match), tokens in the query string are refused, session cookies are never read, the audience must equal the surface's canonical URI, and staff tokens need a current staff role. Failures answer 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`; `insufficientScope()` builds the 403 step-up challenge.

## Rules enforced in the database

- Tokens and codes are stored only as SHA-256 hashes; the runtime role cannot read codes, families or tokens at all, and reads only its own connections, consents, connected clients, calls and challenges.
- A code redeems once: concurrent redemptions serialise on the code row and exactly one issues tokens; a second presentation revokes what the first issued (RFC 6749 section 4.1.2). Any failed redemption (wrong verifier, missing verifier, wrong client, redirect URI or resource) consumes the code.
- A refresh token rotates once; presenting a rotated refresh token revokes the whole family and suspends the connection until the person allows it again on the site. A rotation ends the family's previous access token.
- A person held by a jurisdiction check (SANC-001) or suspended by a confirmed screening match (SANC-003) gets no code, no token and no refresh, and existing tokens stop at the next check. A disabled client and an expired or withdrawn consent end their tokens the same way.
- A password change or account recovery (any new password hash) revokes every token family of the person; the connection stays so the client can ask the person to sign in again.
- Consent rows are history: a new consent supersedes the previous one for the same person, client id, redirect URI and surface. Loopback redirect URIs match any port (RFC 8252 section 7.3).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MCP_ADMIN_ENDPOINT` | `false` | Serve the staff surface `/mcp/admin` |
| `MCP_DYNAMIC_REGISTRATION` | `true` | Accept deprecated dynamic registration |
| `MCP_CLIENT_TRUST` | `any_https_client` | Or `listed_clients_only` (needs `MCP_LISTED_CLIENTS`) |
| `MCP_LISTED_CLIENTS` | `[]` | JSON `[{"clientId","displayName"}]`; listing is informational and never grants scope |
| `MCP_CLIENT_METADATA_FETCH` | the deployment's provider mode | `live` (egress guard, pinned HTTPS), `fake` (scriptable, refused in production) or `disabled` |
| `MCP_ACCESS_TOKEN_TTL_SECONDS` | `900` | 60 to 900 |
| `MCP_REFRESH_ABSOLUTE_DAYS`, `MCP_REFRESH_IDLE_DAYS` | `180`, `90` | Refresh family lifetime and idle expiry |
| `MCP_CONSENT_TEXT_VERSION` | `1` | A consent given under another version is asked again |
| `MCP_REGISTRATIONS_PER_HOUR` | `10` | Dynamic registrations per client address |

## Not in this package

- Routing: the web front routes only `/v1/*` to the API (WEB-004). The well-known documents must also reach the API at the origin root (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/*`): a rewrite in the web front or the reverse proxy (OPS-002).
- Screens: the consent page at `/oauth/consent` and Settings, Connections are MCP-070; nothing here renders text for people (protocol `error_description` values are English for clients).
- Pre-registration of company systems (two people on the company page) has the data model and `private_key_jwt` verification here; the creation flow belongs to the company representative work.
- `connection_call` and `connection_confirmation_challenge` rows are written by MCP-003 and MCP-005.
