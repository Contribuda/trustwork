import { z } from 'zod';
import {
  CapabilitySchema, DenyReasonSchema, PrincipalSchema, ProjectionLayerSchema, type Capability, type ObjectParticipation, type ResourceRef,
} from '../../deps/contracts.js';
import type { ObjectParticipation as ParticipationRow } from '../../deps/data.js';
import { evaluatePolicy } from '../identity/policy/policy.js';
import { toParticipation } from '../identity/serializers.js';
import type { ExplainInputsJson } from './deps.js';

/**
 * The access explainer's answer: the policy decision for one person, one object and one capability as reason codes
 * only. It never carries an id, a name, a participation, a membership, a projection field or any other value of the
 * object or the person (the strict schema refuses anything else): "why can't my colleague see this project?" is
 * answered with `participation_revoked`, `membership_ended`, `capability_missing`… and nothing more.
 */
export const AccessExplanationSchema = z.discriminatedUnion('effect', [
  z.strictObject({ effect: z.literal('allow'), capability: CapabilitySchema, projection: ProjectionLayerSchema, basis: z.array(z.enum(['owner', 'participation', 'membership', 'mandate', 'staff_case', 'public_projection'])).min(1) }),
  z.strictObject({ effect: z.literal('deny'), capability: CapabilitySchema, reason: DenyReasonSchema, disclose: z.enum(['not_found', 'forbidden', 'step_up']) }),
]);
export type AccessExplanation = z.infer<typeof AccessExplanationSchema>;

const NO_OWNER = '00000000-0000-4000-8000-000000000000';
const date = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(String(v)));

function participation(row: Record<string, unknown>): ObjectParticipation {
  return toParticipation({ ...row, valid_from: date(row.valid_from), valid_until: date(row.valid_until), revoked_at: date(row.revoked_at), created_at: date(row.created_at), updated_at: date(row.updated_at) } as unknown as ParticipationRow);
}

/** Pure: evaluates the identity policy (deny by default) for the subject and maps the decision to reason codes. */
export function explainAccess(personId: string, inputs: ExplainInputsJson, resource: ResourceRef, capability: Capability, now: Date): AccessExplanation {
  const principal = PrincipalSchema.parse({
    personId, emailVerified: inputs.emailVerified, authenticatedAt: now.toISOString(), authzEpoch: inputs.authzEpoch,
    membership: inputs.membership, staff: [], delegation: null,
  });
  const rows = inputs.rows.map(participation);
  const decision = evaluatePolicy({
    principal, action: capability, participations: rows, now,
    resource: { kind: resource.kind, id: resource.id, ownerParty: inputs.owner ?? { kind: 'person', id: NO_OWNER }, lifecycle: 'current', publishedProjection: false },
  });
  if (decision.effect === 'allow') {
    return AccessExplanationSchema.parse({ effect: 'allow', capability, projection: decision.projection, basis: [...new Set(decision.basis.map((b) => b.kind))] });
  }
  let reason = decision.reason;
  // Access that came through a former employer: say so instead of "no participation".
  const viaEnded = (inputs.owner?.kind === 'company' && inputs.endedCompanies.includes(inputs.owner.id))
    || rows.some((r) => r.party.kind === 'company' && inputs.endedCompanies.includes(r.party.id) && r.revokedAt === null);
  if (viaEnded && (reason === 'no_participation' || reason === 'membership_permission_missing')) reason = 'membership_ended';
  return AccessExplanationSchema.parse({ effect: 'deny', capability, reason, disclose: decision.disclose });
}
