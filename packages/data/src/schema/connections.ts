import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Connections module (MCP-002, packages/data/migrations/connections; ADR 013 decisions 5 to 9): the hub authorization
 * server's records for the MCP surfaces. Client registrations, the person's consents and connections, single-use
 * authorization codes, token families and tokens (SHA-256 hashes only), the call audit and on-site confirmation
 * challenges. The runtime role reads only the caller's own connections, consents, connected clients, calls and
 * challenges; every write goes through the owner-run `oauth_*` and `connection_*` commands.
 */
export type OAuthClientRegistration = 'client_id_metadata_document' | 'pre_registered' | 'dynamic_registration';
export type ConnectionSurface = 'participant' | 'admin';
export type ConnectionStatus = 'active' | 'suspended' | 'revoked' | 'expired';
export type ConnectionStatusReason = 'refresh_reuse' | 'person_revocation' | 'consent_expired' | 'client_disabled';
export type TokenFamilyRevokedReason = 'refresh_reuse' | 'code_replay' | 'client_revocation' | 'person_revocation' | 'credential_change' | 'consent_superseded';
export interface MandateBindingRow { mandateId: string; revision: number }

export interface OAuthClientTable {
  id: Generated<string>;
  client_id: string;
  registration: OAuthClientRegistration;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string[];
  application_type: 'web' | 'native';
  token_endpoint_auth_method: 'none' | 'private_key_jwt';
  jwks: unknown | null;
  company_id: string | null;
  metadata_digest: string | null;
  metadata_fetched_at: Date | null;
  metadata_expires_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_used_at: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}
export type OAuthClientRow = Selectable<OAuthClientTable>;

export interface ConnectionConsentTable {
  id: Generated<string>;
  person_id: string;
  client_ref: string;
  client_id: string;
  redirect_uri: string;
  surface: ConnectionSurface;
  scopes: string[];
  private_data_classes: Generated<string[]>;
  private_class_acknowledgements: Generated<{ dataClass: string; acknowledgedAt: string }[]>;
  toolsets: Generated<string[]>;
  mandate_bindings: Generated<MandateBindingRow[]>;
  consent_text_version: number;
  step_up: boolean;
  elevation_id: string | null;
  locale: string;
  granted_at: Generated<Date>;
  expires_at: Date;
  withdrawn_at: Date | null;
  withdrawn_reason: 'superseded' | 'person_revocation' | 'refresh_reuse_pending' | 'expired' | null;
}
export type ConnectionConsentRow = Selectable<ConnectionConsentTable>;

export interface ConnectionTable {
  id: Generated<string>;
  hub_id: string | null;
  person_id: string;
  protocol: Generated<'mcp'>;
  surface: ConnectionSurface;
  client_ref: string;
  client_id: string;
  resource: string;
  redirect_uri: string;
  consent_id: string;
  rate_limit_profile: Generated<string>;
  status: Generated<ConnectionStatus>;
  status_reason: ConnectionStatusReason | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revision: Generated<number>;
}
export type ConnectionRow = Selectable<ConnectionTable>;

export interface OAuthAuthorizationCodeTable {
  id: Generated<string>;
  code_hash: Buffer;
  connection_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scopes: string[];
  dpop_jkt: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface ConnectionTokenFamilyTable {
  id: Generated<string>;
  connection_id: string;
  code_id: string;
  audience: string;
  dpop_jkt: string | null;
  created_at: Generated<Date>;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: TokenFamilyRevokedReason | null;
}

export interface ConnectionTokenTable {
  id: Generated<string>;
  family_id: string;
  connection_id: string;
  kind: 'access' | 'refresh';
  token_hash: Buffer;
  audience: string;
  issued_at: Generated<Date>;
  expires_at: Date;
  rotated_from_id: string | null;
  used_at: Date | null;
  revoked_at: Date | null;
}

export interface ConnectionCallTable {
  id: Generated<string>;
  connection_id: string;
  token_family_id: string;
  capability_id: string;
  args_digest: string;
  result_code: string;
  mandate_ref: MandateBindingRow | null;
  action_intent_id: string | null;
  at: Generated<Date>;
}
export type ConnectionCallRow = Selectable<ConnectionCallTable>;

export interface ConnectionConfirmationChallengeTable {
  id: string;
  person_id: string;
  connection_id: string;
  capability_id: string;
  capability_version: number;
  action_intent_id: string;
  action_digest: string;
  mandate_ref: MandateBindingRow | null;
  confirmation: 'mandate' | 'person_each' | 'person_each_step_up';
  status: Generated<'pending' | 'confirmed' | 'declined' | 'expired' | 'consumed'>;
  created_at: Generated<Date>;
  expires_at: Date;
  decided_at: Date | null;
  consumed_at: Date | null;
}
export type ConnectionConfirmationChallengeRow = Selectable<ConnectionConfirmationChallengeTable>;

export interface ConnectionsDatabase {
  oauth_client: OAuthClientTable;
  connection_consent: ConnectionConsentTable;
  connection: ConnectionTable;
  oauth_authorization_code: OAuthAuthorizationCodeTable;
  connection_token_family: ConnectionTokenFamilyTable;
  connection_token: ConnectionTokenTable;
  connection_call: ConnectionCallTable;
  connection_confirmation_challenge: ConnectionConfirmationChallengeTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ConnectionsDatabase {}
}

const columns = columnsOf<ConnectionsDatabase>();
export const TABLE_COLUMNS: TableColumns<ConnectionsDatabase> = {
  oauth_client: columns('oauth_client', ['id', 'client_id', 'registration', 'client_name', 'client_uri', 'redirect_uris', 'application_type', 'token_endpoint_auth_method', 'jwks',
    'company_id', 'metadata_digest', 'metadata_fetched_at', 'metadata_expires_at', 'created_at', 'updated_at', 'last_used_at', 'disabled_at', 'disabled_reason']),
  connection_consent: columns('connection_consent', ['id', 'person_id', 'client_ref', 'client_id', 'redirect_uri', 'surface', 'scopes', 'private_data_classes',
    'private_class_acknowledgements', 'toolsets', 'mandate_bindings', 'consent_text_version', 'step_up', 'elevation_id', 'locale', 'granted_at', 'expires_at', 'withdrawn_at',
    'withdrawn_reason']),
  connection: columns('connection', ['id', 'hub_id', 'person_id', 'protocol', 'surface', 'client_ref', 'client_id', 'resource', 'redirect_uri', 'consent_id', 'rate_limit_profile',
    'status', 'status_reason', 'created_at', 'updated_at', 'last_used_at', 'revoked_at', 'revision']),
  oauth_authorization_code: columns('oauth_authorization_code', ['id', 'code_hash', 'connection_id', 'client_id', 'redirect_uri', 'code_challenge', 'resource', 'scopes', 'dpop_jkt',
    'created_at', 'expires_at', 'consumed_at']),
  connection_token_family: columns('connection_token_family', ['id', 'connection_id', 'code_id', 'audience', 'dpop_jkt', 'created_at', 'absolute_expires_at', 'revoked_at', 'revoked_reason']),
  connection_token: columns('connection_token', ['id', 'family_id', 'connection_id', 'kind', 'token_hash', 'audience', 'issued_at', 'expires_at', 'rotated_from_id', 'used_at', 'revoked_at']),
  connection_call: columns('connection_call', ['id', 'connection_id', 'token_family_id', 'capability_id', 'args_digest', 'result_code', 'mandate_ref', 'action_intent_id', 'at']),
  connection_confirmation_challenge: columns('connection_confirmation_challenge', ['id', 'person_id', 'connection_id', 'capability_id', 'capability_version', 'action_intent_id',
    'action_digest', 'mandate_ref', 'confirmation', 'status', 'created_at', 'expires_at', 'decided_at', 'consumed_at']),
};
