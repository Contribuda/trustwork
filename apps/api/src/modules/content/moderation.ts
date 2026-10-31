import type { Transaction } from '../../deps/data.js';
import { contentModeration } from './deps.js';

/** The effect ADM-001 asks a content owner to apply (structurally its `ModerationEffect`; this module never imports platform-admin). */
export interface ContentModerationEffect {
  hubId: string;
  targetKind: string;
  targetId: string;
  moderationCaseId: string;
  effect: 'hold' | 'remove' | 'restore' | 'none';
  decidedBy: string;
}
interface ModerationTargets { apply(trx: Transaction, effect: ContentModerationEffect): Promise<void> }

/**
 * CNT-001's adapter for ADM-001's `ModerationTargetPort`: a hold or removal of a publication or a comment takes it out
 * of every public projection inside the staff command's transaction, a restoration brings it back. The database checks
 * that the moderation case supports the effect (a refusal rolls the staff decision back). Effects on targets other
 * modules own are passed on to `next` (the composition root keeps ADM-001's recording fake there until those modules
 * land), as are content effects, so the facade keeps one record of every effect it asked for.
 */
export class ContentModerationTargets implements ModerationTargets {
  constructor(readonly next: ModerationTargets | null = null) {}

  async apply(trx: Transaction, effect: ContentModerationEffect): Promise<void> {
    if (effect.targetKind === 'publication' || effect.targetKind === 'publication_comment') await contentModeration.apply(trx, effect.moderationCaseId, effect.effect);
    await this.next?.apply(trx, effect);
  }
}
