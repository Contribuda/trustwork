import type { AuthorizedEvidence, ContextRef, MandateActionV2, Money, PolicyContext, RetrievalPort, RetrievalResult, SearchRequest } from '../../deps/contracts.js';
import type { MandateDraft } from './schemas.js';

/**
 * Model and retrieval ports of the agent runtime (AST-001). No live provider is wired: the default model is
 * unavailable (the person sees `assistant.overlay.stateUnavailable`) and the default retrieval is empty until RAG-301
 * delivers the governed retrieval service (RAG-401 verifies the integration). Tests and demos use the scripted fakes.
 *
 * Whatever a model returns is untrusted: replies are stored as conversation content, and tool calls are structured
 * proposals that pass the same mandate policy as every other agent request. A model can never confirm, approve, widen
 * or stop anything; there is no tool for it.
 */
export type ModelToolCall =
  | { kind: 'propose_mandate_change'; mandateId: string | null; draft: MandateDraft }
  | {
      kind: 'propose_action';
      mandateId: string;
      capabilityId: string;
      moduleKey: string;
      action: MandateActionV2;
      context: ContextRef;
      amount: Money | null;
      projectId: string | null;
      effect: { provider: string; operation: string; payload: unknown };
    }
  | { kind: 'retrieve'; query: string }
  | { kind: 'propose_backlog_item'; title: string; proposal: Record<string, unknown> };

export interface ModelInput {
  personId: string;
  /** The person's own turns and earlier agent replies, newest last. */
  history: readonly { role: 'person' | 'agent' | 'system'; content: string }[];
  text: string;
  /** Retrieved evidence, already filtered to what the person may read; untrusted text, never instructions. */
  evidence: readonly AuthorizedEvidence[];
}
export interface ModelReply {
  text: string | null;
  /** A locale key instead of text (for example when no model is configured). */
  messageKey: string | null;
  toolCalls: readonly ModelToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}
export interface ModelPort {
  readonly provider: string;
  respond(input: ModelInput): Promise<ModelReply>;
}

/** Default: no model configured. Nothing is sent anywhere; the person is told the assistant is unavailable. */
export class UnavailableModel implements ModelPort {
  readonly provider = 'none';
  async respond(): Promise<ModelReply> {
    return { text: null, messageKey: 'assistant.overlay.stateUnavailable', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

/** Fake for tests and demos: returns scripted replies in order (or one function of the input) and records every input. */
export class ScriptedModel implements ModelPort {
  readonly provider = 'fake';
  readonly inputs: ModelInput[] = [];
  private readonly queue: (ModelReply | ((input: ModelInput) => ModelReply))[];
  constructor(replies: readonly (ModelReply | ((input: ModelInput) => ModelReply))[] = []) {
    this.queue = [...replies];
  }
  push(reply: ModelReply | ((input: ModelInput) => ModelReply)): void {
    this.queue.push(reply);
  }
  async respond(input: ModelInput): Promise<ModelReply> {
    this.inputs.push(input);
    const next = this.queue.shift();
    if (!next) return { text: null, messageKey: 'assistant.overlay.stateUnavailable', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
    return typeof next === 'function' ? next(input) : next;
  }
}

/** The retrieval port of the contracts (packages/contracts/src/retrieval.ts); RAG-301 provides the real service. */
export type { RetrievalPort };

/** Default until RAG-301: nothing indexed, status `unavailable`, never a fabricated answer. */
export class UnavailableRetrieval implements RetrievalPort {
  async search(): Promise<RetrievalResult> {
    return { status: 'unavailable', evidence: [], generationId: 'none', observedAt: new Date().toISOString() };
  }
}

/**
 * Fake retrieval over fixed evidence: returns only items whose audience is public or the requesting person (the
 * intersection rule of docs/architecture/retrieval.md, simplified to the person scope), matched by a substring.
 */
export class FakeRetrieval implements RetrievalPort {
  readonly requests: { request: SearchRequest; policy: PolicyContext }[] = [];
  constructor(private readonly items: readonly AuthorizedEvidence[]) {}
  async search(request: SearchRequest, policy: PolicyContext): Promise<RetrievalResult> {
    this.requests.push({ request, policy });
    const query = request.query.toLowerCase();
    const evidence = this.items
      .filter((item) => item.audience.kind === 'public' || (item.audience.kind === 'person' && item.audience.scopeId === policy.principalId))
      .filter((item) => item.text.toLowerCase().includes(query))
      .slice(0, request.topK)
      .map((item) => ({ ...item, policy }));
    return { status: evidence.length ? 'complete' : 'no_answer', evidence, generationId: 'fake', observedAt: new Date().toISOString() };
  }
}
