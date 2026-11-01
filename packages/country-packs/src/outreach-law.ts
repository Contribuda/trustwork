import { z } from 'zod';
import {
  NoticeTimingSchema, OutreachBasisSchema, OutreachChannelSchema, RecipientClassSchema,
  type OutreachPackRule,
} from '../../contracts/src/outreach-policy.js';

/**
 * The `outreachLaw` facet (OUTR-001, ADR 017): sourced facts about a jurisdiction's rules for contacting people and
 * companies who are not participants, in the same shape as `agentLaw`. Facts describe the law; they never switch
 * outreach on. Every fact stays below `official` until counsel review (`counselReview: done`).
 *
 * The fields are declared here and registered in `facets.ts` through `outreachLawFields`, so this module does not
 * import the facet base (no import cycle). A fact describes the law as it is, even where the engine floor is stricter
 * (consumer e-mail under an opt-out law, for example): the resolver applies the floor to every message.
 */
export const OUTREACH_LAW_TOPICS = ['basis', 'notice', 'identification', 'opt-out', 'volume', 'quiet-hours', 'registration', 'retention', 'residency', 'other'] as const;

export function outreachLawFields<T extends z.ZodType>(factText: T) {
  return {
    topic: z.enum(OUTREACH_LAW_TOPICS),
    summary: factText,
    /** For `basis` facts: the recipient classes and channels the rule covers, and the basis it requires. */
    recipientClasses: z.array(RecipientClassSchema).min(1).optional(),
    channels: z.array(OutreachChannelSchema).min(1).optional(),
    basis: OutreachBasisSchema.optional(),
    noticeTiming: NoticeTimingSchema.optional(),
    noticeMaxDays: z.int().min(0).max(90).optional(),
    honourOptOutWithinDays: z.int().min(0).max(60).optional(),
    counselReview: z.enum(['pending', 'done']).default('pending'),
  };
}

/** The structural view of an outreachLaw fact the helpers below need. */
export interface OutreachLawFactView {
  id: string; topic: (typeof OUTREACH_LAW_TOPICS)[number]; verification: string; counselReview: 'pending' | 'done';
  recipientClasses?: readonly string[]; channels?: readonly string[]; basis?: string;
}

/** Problems of one outreachLaw fact beyond its schema (called by the pack validator). */
export function outreachLawProblems(fact: OutreachLawFactView, at: string): string[] {
  const problems: string[] = [];
  if (fact.verification === 'official' && fact.counselReview !== 'done') problems.push(`${at}: outreach-law facts stay unverified until counsel review (counselReview: done)`);
  if (fact.topic === 'basis' && (!fact.recipientClasses || !fact.channels || !fact.basis)) problems.push(`${at}: a basis fact names its recipient classes, channels and basis`);
  if (fact.topic !== 'basis' && (fact.recipientClasses || fact.channels || fact.basis)) problems.push(`${at}: only basis facts carry recipient classes, channels and a basis`);
  return problems;
}

/**
 * Pack rules for the resolver from the outreachLaw facts of one scope (a country, a subdivision or a layer applied to
 * a member). Several facts covering the same class and channel keep the most protective basis when resolved.
 */
export function outreachPackRules(scope: string, facts: readonly OutreachLawFactView[]): OutreachPackRule[] {
  const rules: OutreachPackRule[] = [];
  for (const fact of facts) {
    if (fact.topic !== 'basis' || !fact.basis) continue;
    const basis = OutreachBasisSchema.parse(fact.basis);
    for (const recipientClass of fact.recipientClasses ?? []) for (const channel of fact.channels ?? []) {
      rules.push({ scope, recipientClass: RecipientClassSchema.parse(recipientClass), channel: OutreachChannelSchema.parse(channel), basis, factIds: [fact.id] });
    }
  }
  return rules;
}
