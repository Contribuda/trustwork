import * as oidc from 'openid-client';
import type { OidcClientConfig } from '../../../config.js';
import { ProviderUnavailableError, type AuthorizationCompletion, type AuthorizationStart, type OidcProviderPort, type ProviderIdentity } from '../ports.js';

/**
 * Sign in with Apple through a manual openid-client `Configuration` (Apple publishes no discovery document):
 * authorization code + PKCE S256 + nonce, token endpoint with the client secret (the ES256-signed JWT that
 * Apple requires, generated and rotated by the operator and passed as `clientSecret`), then the identity
 * comes from the validated ID token (`sub`, optional `email`, `email_verified`). The flow asks for no scopes
 * so Apple answers over the query string (any scope forces `response_mode=form_post`, which this slice's
 * GET callback does not accept); an address, when present, counts as verified only when Apple says so,
 * otherwise it enters unverified (H06). Live only; never exercised by tests (fake adapters).
 */
export class AppleSignInProvider implements OidcProviderPort {
  readonly provider = 'apple' as const;
  private readonly configuration: oidc.Configuration;
  constructor(private readonly client: OidcClientConfig) {
    this.configuration = new oidc.Configuration(
      {
        issuer: 'https://appleid.apple.com',
        authorization_endpoint: 'https://appleid.apple.com/auth/authorize',
        token_endpoint: 'https://appleid.apple.com/auth/token',
        jwks_uri: 'https://appleid.apple.com/auth/keys',
        id_token_signing_alg_values_supported: ['RS256'],
      },
      client.clientId,
      client.clientSecret,
    );
  }

  async authorizationUrl(start: AuthorizationStart): Promise<string> {
    return oidc.buildAuthorizationUrl(this.configuration, {
      redirect_uri: start.redirectUri, scope: 'openid', state: start.state, nonce: start.nonce,
      code_challenge: start.codeChallenge, code_challenge_method: 'S256',
    }).toString();
  }

  async complete(completion: AuthorizationCompletion): Promise<ProviderIdentity> {
    const callback = new URL(completion.redirectUri);
    callback.searchParams.set('code', completion.code);
    callback.searchParams.set('state', completion.state);
    let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
    try {
      tokens = await oidc.authorizationCodeGrant(this.configuration, callback, { pkceCodeVerifier: completion.codeVerifier, expectedNonce: completion.nonce, expectedState: completion.state, idTokenExpected: true });
    } catch (error) {
      throw new ProviderUnavailableError('apple', String(error));
    }
    const claims = tokens.claims();
    if (!claims?.sub) throw new ProviderUnavailableError('apple', 'id token without subject');
    const email = typeof claims.email === 'string' ? claims.email : null;
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    return { subject: claims.sub, email, emailVerified: Boolean(email) && verified, name: null };
  }
}
