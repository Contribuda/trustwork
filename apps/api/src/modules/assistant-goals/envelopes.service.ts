import {
  computeDigest, ENVELOPE_INTENT_ACTION, ENVELOPE_MODULE_KEYS, type ContextRef, type SendEnvelopeCommand,
} from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { AgentsBase, envelopeView, isUuid, iso, mandateProof, sessionView, type AgentsSettings } from './common.js';
import { actionDigest, actionIntents, companyMandates, decide, envelopes, negotiationSessions, type PolicySettings } from './deps.js';

/**
 * Agent-to-agent envelopes and negotiation sessions (AGT-001). The agent side sends a structured envelope; the server
 * derives who speaks from the acting mandate (the person's own agent, a colleague's agent under a company mandate, or
 * the company's representative run by its accountable person), decides the person's own-agent mandate with
 * evaluateMandateV2 (asking the person when the mandate asks) and hands the rest to `agents_deliver_envelope`, which
 * repeats every check and applies the session rules and the receiver's own mandate decision. Notes are stored as
 * untrusted text and never read to decide anything.
 */
export class EnvelopesService extends AgentsBase {
  constructor(ctx: AppContext, principals: PrincipalService, private readonly policy: PolicySettings, private readonly settings: AgentsSettings) {
    super(ctx, principals);
  }

  send(body: SendEnvelopeCommand, state: RequestState) {
    return this.run(state, async (trx, p) => {
      if (!isUuid(body.to.id) || !isUuid(body.context.id) || (body.negotiationSessionId !== null && !isUuid(body.negotiationSessionId))) throw new ApiError('access.not_found', 'party, context or session not found');
      const action = ENVELOPE_INTENT_ACTION[body.intent];
      const context: ContextRef = { kind: body.context.kind, id: body.context.id };
      const noteDigest = body.note === null ? null : computeDigest({ text: body.note.text }).value;
      // The exact envelope an approval binds (structured parts only; the note by digest).
      const effect = { provider: 'agent_mesh', operation: 'envelope.send', payload: { to: body.to, context, intent: body.intent, refs: body.refs, noteDigest, expiresAt: body.expiresAt } };
      let subject: string;
      if (body.actingAs.kind === 'own_agent') {
        const { outcome, row } = await decide(trx, { personId: p.personId, mandateId: body.actingAs.mandateId, moduleKeys: ENVELOPE_MODULE_KEYS, action, context, amount: null, projectId: null, at: this.now() }, this.policy);
        if (outcome.effect === 'deny' || !row) {
          const reason = outcome.effect === 'deny' ? outcome.reason : 'not_found';
          if (reason === 'not_found') throw new ApiError('access.not_found', 'mandate not found');
          throw new ApiError(reason === 'kill_switch' ? 'access.mandate_revoked' : 'access.mandate_scope', reason, { reason });
        }
        const capabilityId = `${outcome.moduleKey}.envelope_${body.intent}`;
        const recorded = await actionIntents.record(trx, {
          runId: null, mandateId: row.id, mandateRevision: row.revision, capabilityId, moduleKey: outcome.moduleKey, action, context: outcome.context, resolvedFromSelector: outcome.resolvedFromSelector,
          amount: null, digest: actionDigest({ mandate: { id: row.id, revision: row.revision }, capabilityId, action, context: outcome.context, amount: null, effect }), effect,
          decision: outcome.effect, askReasons: outcome.effect === 'ask' ? outcome.reasons : [],
        });
        if (recorded.state === 'proposed') {
          // "Your decision is needed": the person approves exactly this envelope; the identical retry is then sent once.
          await this.audit(trx, p, state, 'agents.envelope_approval_required', 'action_intent', recorded.intentId as string, { intent: body.intent });
          return { status: 'approval_required' as const, reason: 'needs_approval', decisionId: recorded.intentId, envelope: null, session: null };
        }
        subject = `mandate:${row.id}:${row.revision}`;
      } else {
        const cm = isUuid(body.actingAs.companyMandateId) ? await companyMandates.get(trx, body.actingAs.companyMandateId) : undefined;
        if (!cm) throw new ApiError('access.not_found', 'company mandate not found');
        subject = `company_mandate:${cm.id}:${cm.revision}`;
      }
      const result = await envelopes.deliver(trx, body.actingAs, {
        to: body.to, context, intent: body.intent, refs: body.refs, note: body.note?.text ?? null, noteLocale: body.note?.locale ?? null, sessionId: body.negotiationSessionId,
        expiresAt: body.expiresAt, proof: mandateProof(this.settings, subject), homeNode: this.settings.homeNode,
      }, {
        hubId: this.policy.hubId, moduleKeys: ENVELOPE_MODULE_KEYS, maxRounds: this.settings.maxNegotiationRounds, sessionTtlSeconds: this.settings.sessionTtlSeconds,
        perCounterpartyPerDay: this.settings.envelopesPerCounterpartyPerDay,
      });
      const envelope = result.envelope_id ? await envelopes.get(trx, result.envelope_id) : undefined;
      const session = result.session_id ? await negotiationSessions.get(trx, result.session_id) : undefined;
      await this.audit(trx, p, state, `agents.envelope_${result.outcome}`, result.envelope_id ? 'agent_envelope' : 'agent_context', result.envelope_id ?? body.context.id,
        { intent: body.intent, actingAs: body.actingAs.kind, reason: result.reason }, body.actingAs.kind === 'own_agent' ? null : p.membership?.companyId ?? null);
      return {
        status: result.outcome, reason: result.reason, decisionId: null, envelope: envelope ? envelopeView(envelope) : null, session: session ? sessionView(session, this.now()) : null,
      };
    });
  }

  /** Envelopes of the parties the person acts for, each with the reader's own receipt when the reader is its receiver. */
  listEnvelopes(state: RequestState) {
    return this.run(state, async (trx) => {
      const rows = await envelopes.list(trx);
      const out = [];
      for (const row of rows) {
        const receipt = await envelopes.receipt(trx, row.id);
        out.push({ ...envelopeView(row), receipt: receipt ? { decision: receipt.decision, reason: receipt.reason, decidedAt: iso(receipt.decided_at) } : null });
      }
      return { envelopes: out };
    });
  }
  listNegotiations(state: RequestState) {
    return this.run(state, async (trx) => ({ sessions: (await negotiationSessions.list(trx)).map((s) => sessionView(s, this.now())) }));
  }
  getNegotiation(id: string, state: RequestState) {
    return this.run(state, async (trx) => {
      const row = isUuid(id) ? await negotiationSessions.get(trx, id) : undefined;
      if (!row) throw new ApiError('access.not_found', 'session not found');
      return { ...sessionView(row, this.now()), envelopes: (await envelopes.listForSession(trx, id)).map(envelopeView) };
    });
  }
}
