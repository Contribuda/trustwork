import type { Transaction } from '../../../deps/data.js';
import { MATCHER_VERSION, nameTokens, screenNames, setupRuns, type OperatorScreening } from './deps.js';

/**
 * Sanctions screening of the operator entity during setup (setup-wizard.md step 4, SANC-003). The port is called with
 * the setup transaction, the token hash and the operator's legal name; a potential match never blocks anything: it is
 * recorded, keeps the `operator_recorded_and_screened` gate open and is shown for a review the operator cannot close.
 */
export interface OperatorScreeningPort {
  screen(trx: Transaction, tokenHash: string, legalName: string, now: Date): Promise<OperatorScreening>;
}

/**
 * The engine baseline: the active list versions and candidate entries come from the database (the setup commands
 * re-check the token), the SANC-003 matcher (`packages/compliance`) compares the name with the engine rule only (the
 * fuzzy layer is off until the owner chooses, ADR 014 open question 3). With no usable baseline the outcome is
 * `not_screened`, never `clear`.
 */
export class EngineOperatorScreening implements OperatorScreeningPort {
  async screen(trx: Transaction, tokenHash: string, legalName: string, now: Date): Promise<OperatorScreening> {
    const lists = await setupRuns.screeningLists(trx, tokenHash);
    const listVersionIds = lists.versions.map((v) => v.versionId);
    const base = { basis: 'engine_baseline' as const, matcherVersion: MATCHER_VERSION, screenedAt: now.toISOString() };
    if (!lists.available || !lists.versions.some((v) => v.baseline)) return { ...base, outcome: 'not_screened', listVersionIds, matches: 0 };
    const tokens = [...new Set(nameTokens(legalName))].sort().slice(0, 64);
    const candidates = tokens.length >= 2 ? await setupRuns.screeningCandidates(trx, tokenHash, { entryTypes: ['entity'], tokens, initials: [] }) : [];
    const report = screenNames('company', [legalName], candidates, { fuzzyThreshold: null });
    return { ...base, outcome: report.outcome, listVersionIds, matches: report.matches.length };
  }
}

/** Test and demo adapter: a fixed outcome, always labelled `fake` ("fake: not a real screening"). */
export class FakeOperatorScreening implements OperatorScreeningPort {
  constructor(private readonly outcome: OperatorScreening['outcome'] = 'clear') {}
  async screen(_trx: Transaction, _tokenHash: string, _legalName: string, now: Date): Promise<OperatorScreening> {
    return { outcome: this.outcome, basis: 'fake', matcherVersion: 'fake', listVersionIds: [], matches: this.outcome === 'possible_match' ? 1 : 0, screenedAt: now.toISOString() };
  }
}
