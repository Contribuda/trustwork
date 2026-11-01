import { z } from 'zod';
import { HubSchema, JurisdictionHoldSchema, ScreeningSubjectPanelSchema, ScreeningConsoleRunSchema, ScreeningMatchSchema, ScreeningQueueItemSchema } from '@trustwork/contracts/client';

// Local decoders of existing endpoint envelopes; domain fields retain their contract schemas.
export const QueueSchema = z.object({ serviceLevelDays: z.number(), items: z.array(ScreeningQueueItemSchema) });
export const SubjectSchema = ScreeningSubjectPanelSchema;
export const MatchDetailSchema = z.object({ match: ScreeningMatchSchema, decisions: z.array(z.object({ id: z.uuid(), kind: z.string(), decidedBy: z.uuid(), reason: z.string(), evidence: z.string().nullable(), decidedAt: z.string() })) });
export const HoldsSchema = z.object({ items: z.array(JurisdictionHoldSchema) });
export const RunsSchema = z.object({ items: z.array(ScreeningConsoleRunSchema) });
export const HubsSchema = z.object({ items: z.array(z.object({ hub: HubSchema })) });
export const NodeSchema = z.object({ nodeId: z.uuid(), label: z.string() });
export const AccessSchema = z.object({ personId: z.uuid(), roles: z.array(z.string()) });
export type Copy = typeof import('../../../../../../locales/en/screening.json').screening.console;
export type MatchDetail = z.infer<typeof MatchDetailSchema>;
