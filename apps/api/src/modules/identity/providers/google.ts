import * as oidc from 'openid-client';
import type { OidcClientConfig } from '../../../config.js';
import { ProviderUnavailableError, type AuthorizationCompletion, type AuthorizationStart, type OidcProviderPort, type ProviderIdentity } from '../ports.js';

/**
 * Google OpenID Connect through openid-client 6 (discovery of https://accounts.google.com, PKCE S256, nonce, issuer /
 * audience / signature validation inside `authorizationCodeGrant`). Only instantiated with AUTH_PROVIDER_MODE=live and
 * credentials; never exercised by tests (fake adapters) and never called during this slice's checks.
 */
export class GoogleOidcProvider implements OidcProviderPort {
  readonly provider = 'google' as const;
  private configuration: Promise<oidc.Configuration> | null = null;
  constructor(private readonly client: OidcClientConfig) {}

  private config(): Promise<oidc.Configuration> {
    this.configuration ??= oidc.discovery(new URL('https://accounts.google.com'), this.client.clientId, this.client.clientSecret).catch((error: unknown) => {
      this.configuration = null;
      throw new ProviderUnavailableError('google', String(error));
    });
    return this.configuration;
  }

  async authorizationUrl(start: AuthorizationStart): Promise<string> {
    const configuration = await this.config();
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: start.redirectUri, scope: 'openid email profile', state: start.state, nonce: start.nonce,
      code_challenge: start.codeChallenge, code_challenge_method: 'S256',
    }).toString();
  }

  async complete(completion: AuthorizationCompletion): Promise<ProviderIdentity> {
    const configuration = await this.config();
    const callback = new URL(completion.redirectUri);
    callback.searchParams.set('code', completion.code);
    callback.searchParams.set('state', completion.state);
    let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
    try {
      tokens = await oidc.authorizationCodeGrant(configuration, callback, { pkceCodeVerifier: completion.codeVerifier, expectedNonce: completion.nonce, expectedState: completion.state, idTokenExpected: true });
    } catch (error) {
      throw new ProviderUnavailableError('google', String(error));
    }
    const claims = tokens.claims();
    if (!claims?.sub) throw new ProviderUnavailableError('google', 'id token without subject');
    return {
      subject: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' ? claims.name : null,
    };
  }
}
