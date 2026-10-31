import type { Transaction } from '../../deps/data.js';

/**
 * Ports through which the administration facade calls other modules' use cases (it never writes their tables). Each
 * call runs inside the staff command's transaction, so a refusal by the owning module rolls the decision, its audit
 * row and its notices back together. Modules that are not accepted yet are served by the recording fakes below; the
 * composition root replaces a fake with the owning module's adapter when that module lands (CNT-001 for content
 * holds, the identity and commerce modules for sanction enforcement). Owning modules implement these interfaces
 * structurally and never import platform-admin.
 */

/** A moderation decision as the owner of the target applies it (hide, restore, label). */
export interface ModerationEffect {
  hubId: string;
  targetKind: string;
  targetId: string;
  moderationCaseId: string;
  effect: 'hold' | 'remove' | 'restore' | 'none';
  decidedBy: string;
}
export interface ModerationTargetPort {
  /** Applies the effect inside `trx`; throws to refuse (the decision then rolls back). */
  apply(trx: Transaction, effect: ModerationEffect): Promise<void>;
}

/** A sanction becoming active or ending, for the modules that enforce it (posting, messaging, marketplace access). */
export interface SanctionChange {
  sanctionId: string;
  hubId: string;
  subject: { kind: 'person' | 'company'; id: string };
  level: number;
  featureScope: string;
  endsAt: string | null;
  change: 'applied' | 'lifted';
}
export interface SanctionEnforcementPort {
  changed(trx: Transaction, change: SanctionChange): Promise<void>;
}

/** Recording fake: keeps every committed and uncommitted call (tests read `calls`). */
export class RecordingModerationTargets implements ModerationTargetPort {
  readonly calls: ModerationEffect[] = [];
  refuse: ((effect: ModerationEffect) => boolean) | null = null;
  async apply(_trx: Transaction, effect: ModerationEffect): Promise<void> {
    if (this.refuse?.(effect)) throw new Error('moderation target refused the effect');
    this.calls.push(effect);
  }
}
export class RecordingSanctionEnforcement implements SanctionEnforcementPort {
  readonly calls: SanctionChange[] = [];
  async changed(_trx: Transaction, change: SanctionChange): Promise<void> {
    this.calls.push(change);
  }
}

export const MODERATION_TARGETS = Symbol('trustwork.platform-admin.moderation-targets');
export const SANCTION_ENFORCEMENT = Symbol('trustwork.platform-admin.sanction-enforcement');
