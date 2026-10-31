import { z } from 'zod';
import { PartySchema } from './access.js';
import { AttachmentRefSchema, BusinessDateSchema, IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { MoneySchema } from './common/money.js';
import { pickFields } from './common/projection.js';
import { Sha256HexSchema } from './common/digest-schema.js';

export const ProjectStatusSchema = z.enum(['planned', 'active', 'suspended', 'completed', 'cancelled']);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const MilestoneSchema = z.strictObject({ id: IdSchema, title: NameSchema, due: BusinessDateSchema, budget: MoneySchema.nullable(), shared: z.boolean() });
/** Participants see shared milestones without their budgets. */
export const SharedMilestoneSchema = MilestoneSchema.omit({ budget: true });
export type SharedMilestone = z.infer<typeof SharedMilestoneSchema>;

/** Owner is exactly one person XOR company; creator and leader are distinct roles and transfer nothing. */
export const ProjectSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  creatorPersonId: IdSchema,
  leaderPersonId: IdSchema.nullable(),
  name: NameSchema,
  summary: TextSchema.nullable(),
  status: ProjectStatusSchema,
  publicity: z.strictObject({ enabled: z.boolean(), publishedStory: TextSchema.nullable(), openNeedIds: z.array(IdSchema), publicParticipantIds: z.array(IdSchema) }),
  milestones: z.array(MilestoneSchema),
  sharedFiles: z.array(AttachmentRefSchema),
  /** owner_private below. */
  baselinePlanId: IdSchema.nullable(),
  budgets: z.array(z.strictObject({ budgetId: IdSchema, limit: MoneySchema })),
  participantIds: z.array(IdSchema),
  privateFiles: z.array(z.strictObject({ evidenceArtifactId: IdSchema, hash: Sha256HexSchema })),
  privateNotes: TextSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const PublicProjectSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  summary: TextSchema.nullable(),
  status: ProjectStatusSchema,
  publishedStory: TextSchema.nullable(),
  openNeedIds: z.array(IdSchema),
  publicParticipantIds: z.array(IdSchema),
});
export type PublicProject = z.infer<typeof PublicProjectSchema>;
/** Publicity never releases prices, files, messages or commitments; unpublished projects are not found. */
export function toPublicProject(project: Project): PublicProject | null {
  if (!project.publicity.enabled) return null;
  return PublicProjectSchema.parse({
    ...pickFields(project, ['id', 'name', 'summary', 'status']),
    publishedStory: project.publicity.publishedStory,
    openNeedIds: project.publicity.openNeedIds,
    publicParticipantIds: project.publicity.publicParticipantIds,
  });
}
export const ParticipantProjectSchema = PublicProjectSchema.extend({
  owner: PartySchema,
  leaderPersonId: IdSchema.nullable(),
  milestones: z.array(SharedMilestoneSchema),
  sharedFiles: z.array(AttachmentRefSchema),
});
export type ParticipantProject = z.infer<typeof ParticipantProjectSchema>;
/** shared_party projection for scoped participants: shared milestones (without budgets) and shared files only. */
export function toParticipantProject(project: Project): ParticipantProject {
  return ParticipantProjectSchema.parse({
    ...pickFields(project, ['id', 'name', 'summary', 'status', 'owner', 'leaderPersonId', 'sharedFiles']),
    publishedStory: project.publicity.publishedStory,
    openNeedIds: project.publicity.openNeedIds,
    publicParticipantIds: project.publicity.publicParticipantIds,
    milestones: project.milestones.filter((m) => m.shared).map((m) => pickFields(m, ['id', 'title', 'due', 'shared'])),
  });
}

export const OwnershipTransferStatusSchema = z.enum(['proposed', 'accepted_by_recipient', 'effective', 'rejected', 'expired', 'withdrawn']);
export type OwnershipTransferStatus = z.infer<typeof OwnershipTransferStatusSchema>;
export const OwnershipTransferSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  from: PartySchema,
  to: PartySchema,
  status: OwnershipTransferStatusSchema,
  proposedBy: IdSchema,
  proposedAt: TimestampSchema,
  recipientConsentAt: TimestampSchema.nullable(),
  effectiveAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema,
}).refine((t) => t.status !== 'effective' || (t.recipientConsentAt !== null && t.effectiveAt !== null), { message: 'effective transfer requires recipient consent', path: ['recipientConsentAt'] });
export type OwnershipTransfer = z.infer<typeof OwnershipTransferSchema>;
const TRANSFER_TRANSITIONS: Record<OwnershipTransferStatus, readonly OwnershipTransferStatus[]> = {
  proposed: ['accepted_by_recipient', 'rejected', 'expired', 'withdrawn'],
  accepted_by_recipient: ['effective', 'expired', 'withdrawn'],
  effective: [], rejected: [], expired: [], withdrawn: [],
};
export function ownershipTransferTransitionAllowed(from: OwnershipTransferStatus, to: OwnershipTransferStatus): boolean {
  return TRANSFER_TRANSITIONS[from].includes(to);
}

export const CreateProjectCommandSchema = z.strictObject({ owner: PartySchema, name: NameSchema, summary: TextSchema.nullable(), leaderPersonId: IdSchema.nullable() });
export const TransferOwnershipCommandSchema = z.strictObject({ projectId: IdSchema, to: PartySchema, expectedRevision: RevisionSchema });
export const AssignLeaderCommandSchema = z.strictObject({ projectId: IdSchema, leaderPersonId: IdSchema.nullable(), expectedRevision: RevisionSchema });
export const PublishProjectCommandSchema = z.strictObject({ projectId: IdSchema, publishedStory: TextSchema, openNeedIds: z.array(IdSchema), expectedRevision: RevisionSchema, reason: ShortTextSchema.optional() });
