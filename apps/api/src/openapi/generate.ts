import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AcceptMembershipCommandSchema, AssignLeaderCommandSchema, ChangeEmailCommandSchema, ChangeMembershipCommandSchema, contractJsonSchemas, CreateProjectCommandSchema, EndMembershipCommandSchema,
  InviteMemberCommandSchema, MembershipSchema, OwnershipTransferSchema, ParticipantProjectSchema, PersonSchema, PrincipalSchema, ProjectSchema, ProviderLinkStartCommandSchema,
  PublishProjectCommandSchema, RecoveryCompleteCommandSchema, RecoveryRequestCommandSchema, RevokeSessionCommandSchema, TransferOwnershipCommandSchema, VerifyEmailCommandSchema,
} from '../deps/contracts.js';
import { ChangePasswordCommandSchema, StepUpCommandSchema } from '../modules/identity/controllers/auth.controller.js';
import { GrantParticipationCommandSchema, RevokeParticipationCommandSchema } from '../modules/projects/projects.controller.js';

/**
 * OpenAPI 3.1 document generated from the frozen Zod contracts (`contractJsonSchemas()` plus the command schemas
 * this slice serves). `z.toJSONSchema` drops `refine` invariants (digest equality, actor != approver, expiry windows,
 * totals): the generated schemas describe shapes only and must not be read as the full invariant set.
 */
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
const local: Record<string, Record<string, unknown>> = {
  Person: json(PersonSchema), Principal: json(PrincipalSchema), Membership: json(MembershipSchema), Project: json(ProjectSchema), ParticipantProject: json(ParticipantProjectSchema), OwnershipTransfer: json(OwnershipTransferSchema),
  VerifyEmailCommand: json(VerifyEmailCommandSchema), RecoveryRequestCommand: json(RecoveryRequestCommandSchema), RecoveryCompleteCommand: json(RecoveryCompleteCommandSchema), StepUpCommand: json(StepUpCommandSchema),
  ChangePasswordCommand: json(ChangePasswordCommandSchema), ChangeEmailCommand: json(ChangeEmailCommandSchema), RevokeSessionCommand: json(RevokeSessionCommandSchema), ProviderLinkStartCommand: json(ProviderLinkStartCommandSchema),
  InviteMemberCommand: json(InviteMemberCommandSchema), AcceptMembershipCommand: json(AcceptMembershipCommandSchema), ChangeMembershipCommand: json(ChangeMembershipCommandSchema), EndMembershipCommand: json(EndMembershipCommandSchema),
  CreateProjectCommand: json(CreateProjectCommandSchema), AssignLeaderCommand: json(AssignLeaderCommandSchema), PublishProjectCommand: json(PublishProjectCommandSchema), TransferOwnershipCommand: json(TransferOwnershipCommandSchema),
  GrantParticipationCommand: json(GrantParticipationCommandSchema), RevokeParticipationCommand: json(RevokeParticipationCommandSchema),
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const envelope = { description: 'Error envelope', content: { 'application/json': { schema: ref('ErrorEnvelope') } } };
const op = (summary: string, options: { body?: string; response?: string | null; status?: number; auth?: 'session' | 'step_up'; idempotent?: boolean; csrf?: boolean; tags: string[] }) => ({
  summary, tags: options.tags,
  ...(options.body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(options.body) } } } } : {}),
  parameters: [
    ...(options.csrf === false ? [] : [{ name: 'X-Trustwork-Request', in: 'header', required: true, schema: { type: 'string', const: '1' }, description: 'Mutation CSRF header; with Sec-Fetch-Site: same-origin or an Origin equal to the public origin.' }]),
    ...(options.idempotent ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]+$' } }] : []),
  ],
  responses: {
    [String(options.status ?? 200)]: options.response === null ? { description: 'No content' } : { description: 'Success', content: { 'application/json': { schema: options.response ? ref(options.response) : { type: 'object' } } } },
    '401': envelope, '403': envelope, '404': envelope, '409': envelope, '422': envelope, '429': envelope,
  },
  'x-trustwork-auth': options.auth ?? 'none',
});
const get = (summary: string, response: string | undefined, auth: 'session' | 'none', tags: string[]) => ({ summary, tags, responses: { '200': { description: 'Success', content: { 'application/json': { schema: response ? ref(response) : { type: 'object' } } } }, '401': envelope, '404': envelope }, 'x-trustwork-auth': auth });
const id = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } });

const document = {
  openapi: '3.1.0',
  info: { title: 'Trustwork API (BE-001 slice)', version: '0.1.0', description: 'Generated from packages/contracts Zod schemas; refinements are dropped by z.toJSONSchema and remain enforced at runtime only. Single origin; session cookie __Host-sr_session; error envelope from ERROR_CODES.' },
  servers: [{ url: '/' }],
  paths: {
    '/health': { get: get('Process liveness', 'Health', 'none', ['health']) },
    '/health/live': { get: get('Process liveness (never touches the database)', 'Health', 'none', ['health']) },
    '/health/ready': { get: { summary: 'Readiness: database reachable and migration ledger verified against this build', tags: ['health'], responses: { '200': { description: 'Ready', content: { 'application/json': { schema: ref('Readiness') } } }, '503': { description: 'Not ready', content: { 'application/json': { schema: ref('Readiness') } } } }, 'x-trustwork-auth': 'none' } },
    '/v1/auth/signup': { post: op('Signup (identical response for existing addresses; no session before verification)', { body: 'SignupCommand', status: 202, tags: ['auth'] }) },
    '/v1/auth/verify-email': { post: op('Consume a verification or e-mail change token; issues the first session', { body: 'VerifyEmailCommand', tags: ['auth'] }) },
    '/v1/auth/login': { post: op('Password login with per-account and per-IP lockout', { body: 'LoginCommand', tags: ['auth'] }) },
    '/v1/auth/logout': { post: op('Revoke the acting session', { status: 204, response: null, tags: ['auth'] }) },
    '/v1/auth/recovery': { post: op('Request recovery (enumeration-safe)', { body: 'RecoveryRequestCommand', status: 202, tags: ['auth'] }) },
    '/v1/auth/recovery/complete': { post: op('Complete recovery with a single-use token; revokes all sessions', { body: 'RecoveryCompleteCommand', tags: ['auth'] }) },
    '/v1/auth/step-up': { post: op('Re-authenticate the acting session', { body: 'StepUpCommand', auth: 'session', tags: ['auth'] }) },
    '/v1/auth/link/start': { post: op('Start provider linking (step-up, verified primary e-mail)', { body: 'ProviderLinkStartCommand', auth: 'step_up', tags: ['auth'] }) },
    '/v1/auth/unlink': { post: op('Unlink a provider (refused when it would leave no credential)', { body: 'ProviderLinkStartCommand', auth: 'step_up', status: 204, response: null, tags: ['auth'] }) },
    '/v1/auth/{provider}/start': { post: { ...op('Start provider login (Google or Apple)', { tags: ['auth'] }), parameters: [id('provider')] } },
    '/v1/auth/{provider}/callback': { get: { summary: 'Provider redirect target; 303 to the return path with ?auth=<outcome>', tags: ['auth'], parameters: [id('provider'), { name: 'code', in: 'query', required: true, schema: { type: 'string' } }, { name: 'state', in: 'query', required: true, schema: { type: 'string' } }], responses: { '303': { description: 'Redirect' }, '400': envelope, '401': envelope, '403': envelope, '409': envelope } } },
    '/v1/me': { get: get('Own person (owner_private) and the resolved principal', undefined, 'session', ['me']) },
    '/v1/me/sessions': { get: get('Own sessions (SessionView, no token hash)', undefined, 'session', ['me']) },
    '/v1/me/sessions/revoke': { post: op('Revoke one own session', { body: 'RevokeSessionCommand', auth: 'session', status: 204, response: null, tags: ['me'] }) },
    '/v1/me/sessions/revoke-others': { post: op('Revoke every other session', { auth: 'step_up', tags: ['me'] }) },
    '/v1/me/password': { post: op('Change password (revokes other sessions)', { body: 'ChangePasswordCommand', auth: 'step_up', status: 204, response: null, tags: ['me'] }) },
    '/v1/me/email': { post: op('Request an e-mail change (verified through /v1/auth/verify-email)', { body: 'ChangeEmailCommand', auth: 'step_up', status: 202, tags: ['me'] }) },
    '/v1/people/{id}': { get: { ...get('Public person projection', 'PublicPerson', 'none', ['people']), parameters: [id('id')] } },
    '/v1/companies/{id}': { get: { ...get('Public company projection plus member view for active members', undefined, 'none', ['companies']), parameters: [id('id')] } },
    '/v1/companies/{id}/memberships': {
      get: { ...get('Memberships of the own company', undefined, 'session', ['companies']), parameters: [id('id')] },
      post: { ...op('Invite a member (company.members.manage, step-up, identical acknowledgement)', { body: 'InviteMemberCommand', auth: 'step_up', idempotent: true, status: 202, tags: ['companies'] }), parameters: [id('id')] },
    },
    '/v1/companies/{id}/memberships/accept': { post: { ...op('Accept an invitation with the mailbox token', { body: 'AcceptMembershipCommand', auth: 'session', idempotent: true, response: 'Membership', tags: ['companies'] }), parameters: [id('id')] } },
    '/v1/companies/{id}/memberships/change': { post: { ...op('Change role/permissions (member manager, never oneself, last administrator kept)', { body: 'ChangeMembershipCommand', auth: 'step_up', idempotent: true, response: 'Membership', tags: ['companies'] }), parameters: [id('id')] } },
    '/v1/companies/{id}/memberships/end': { post: { ...op('End a membership (self or member manager) with the revocation sequence', { body: 'EndMembershipCommand', auth: 'step_up', idempotent: true, tags: ['companies'] }), parameters: [id('id')] } },
    '/v1/projects': { post: op('Create a project (owner person XOR company; owner row materialised)', { body: 'CreateProjectCommand', auth: 'session', idempotent: true, status: 201, response: 'Project', tags: ['projects'] }) },
    '/v1/projects/{id}': { get: { ...get('Project by the highest readable projection (public, shared_party, owner_private)', undefined, 'none', ['projects']), parameters: [id('id')] } },
    '/v1/projects/{id}/leader': { post: { ...op('Assign the operational leader (transfers no ownership)', { body: 'AssignLeaderCommand', auth: 'session', idempotent: true, response: 'Project', tags: ['projects'] }), parameters: [id('id')] } },
    '/v1/projects/{id}/publish': { post: { ...op('Publish the allowlisted public projection', { body: 'PublishProjectCommand', auth: 'session', idempotent: true, response: 'Project', tags: ['projects'] }), parameters: [id('id')] } },
    '/v1/projects/{id}/transfers': {
      get: { ...get('Ownership transfers visible to the principal', undefined, 'session', ['projects']), parameters: [id('id')] },
      post: { ...op('Propose an ownership transfer (recipient consent required)', { body: 'TransferOwnershipCommand', auth: 'step_up', idempotent: true, status: 201, response: 'OwnershipTransfer', tags: ['projects'] }), parameters: [id('id')] },
    },
    '/v1/projects/{id}/transfers/{transferId}/consent': { post: { ...op('Recipient consents', { auth: 'step_up', idempotent: true, response: 'OwnershipTransfer', tags: ['projects'] }), parameters: [id('id'), id('transferId')] } },
    '/v1/projects/{id}/transfers/{transferId}/reject': { post: { ...op('Recipient rejects', { auth: 'session', idempotent: true, response: 'OwnershipTransfer', tags: ['projects'] }), parameters: [id('id'), id('transferId')] } },
    '/v1/projects/{id}/transfers/{transferId}/withdraw': { post: { ...op('Proposer withdraws', { auth: 'session', idempotent: true, response: 'OwnershipTransfer', tags: ['projects'] }), parameters: [id('id'), id('transferId')] } },
    '/v1/projects/{id}/transfers/{transferId}/apply': { post: { ...op('Owner applies an accepted transfer; owner row re-materialised', { auth: 'step_up', idempotent: true, response: 'Project', tags: ['projects'] }), parameters: [id('id'), id('transferId')] } },
    '/v1/projects/{id}/participants': {
      get: { ...get('Participation rows (owner_private)', undefined, 'session', ['projects']), parameters: [id('id')] },
      post: { ...op('Grant a scoped participant within canGrant (no amplification)', { body: 'GrantParticipationCommand', auth: 'session', idempotent: true, status: 201, response: 'ObjectParticipation', tags: ['projects'] }), parameters: [id('id')] },
    },
    '/v1/projects/{id}/participants/{participationId}/revoke': { post: { ...op('Revoke a participation (manager or the party itself; owner row protected)', { body: 'RevokeParticipationCommand', auth: 'session', idempotent: true, response: 'ObjectParticipation', tags: ['projects'] }), parameters: [id('id'), id('participationId')] } },
  },
  components: { schemas: { ...contractJsonSchemas(), ...local } },
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../openapi/openapi.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${out} (${Object.keys(document.paths).length} paths, ${Object.keys(document.components.schemas).length} schemas)`);
