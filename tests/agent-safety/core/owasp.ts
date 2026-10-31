/**
 * The two OWASP lists the agent safety suite is mapped to (EVAL-001):
 * - OWASP Top 10 for LLM Applications 2025 (https://genai.owasp.org/llm-top-10/), items LLM01 to LLM10;
 * - OWASP Top 10 for Agentic Applications 2026 (https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/),
 *   published December 2025, items ASI01 to ASI10.
 *
 * `scope` states what the deterministic suite covers for the item and what it cannot cover (a scripted fake model
 * proves structural defences, never a real model's behaviour). `notApplicable` is set only when no part of the item can
 * occur in the engine; such an item needs no scenario but keeps the written reason in every report.
 */
export interface OwaspItem {
  id: string;
  title: string;
  scope: string;
  notApplicable?: string;
}
export interface OwaspFramework {
  id: 'owasp-llm-2025' | 'owasp-agentic-2026';
  title: string;
  url: string;
  items: readonly OwaspItem[];
}

export const OWASP_LLM_2025: OwaspFramework = {
  id: 'owasp-llm-2025',
  title: 'OWASP Top 10 for LLM Applications 2025',
  url: 'https://genai.owasp.org/llm-top-10/',
  items: [
    { id: 'LLM01', title: 'Prompt Injection', scope: 'Direct (chat) and indirect (attachments, imported news, e-mail, web pages, counterpart agent notes, retrieved evidence) injection where the model obeys the injected text; the suite asserts that no obeyed instruction gains authority. Whether a real model resists injection is out of scope (opt-in provider evaluation).' },
    { id: 'LLM02', title: 'Sensitive Information Disclosure', scope: 'Private constraints (floors, ceilings, budgets, approvers, conditions) in effect payloads, counterparty projections and model input; competitor pricing through retrieval; egress of non-public data classes to model providers. Value-level redaction of free text written by a real model is not covered (see the report limitations).' },
    { id: 'LLM03', title: 'Supply Chain', scope: 'Third-party model providers (egress rules, vendor training and retention flags, second-person activation of private routes) and capability declarations of modules and extensions. Package dependency pinning and provenance are covered by the lockfile and CI, not by this suite.' },
    { id: 'LLM04', title: 'Data and Model Poisoning', scope: 'Poisoned retrieval evidence and imported sources that try to steer the agent. The engine trains or fine-tunes no model, so training-data poisoning has no surface in this release.' },
    { id: 'LLM05', title: 'Improper Output Handling', scope: 'Model tool calls are validated structured proposals: unknown tool kinds, malformed capability, provider and operation identifiers are refused; reply text is stored as content and never executed or interpreted as a command.' },
    { id: 'LLM06', title: 'Excessive Agency', scope: 'Mandate scope (module, action, context, ceiling, window), human-only verbs, approvals bound to digests, restricted places, connections that may only propose.' },
    { id: 'LLM07', title: 'System Prompt Leakage', scope: 'No authority, limit, budget, session token or secret is placed in model input, so a leaked prompt reveals nothing that grants or describes authority. The engine has no hidden system prompt carrying secrets.' },
    { id: 'LLM08', title: 'Vector and Embedding Weaknesses', scope: 'Retrieval runs with the server-derived principal; evidence outside the person\'s audience never reaches the run; derived answers take the intersection of audiences. The vector store itself is covered by tests/retrieval and the RAG packages.' },
    { id: 'LLM09', title: 'Misinformation', scope: 'With no model or no retrieval the agent says it is unavailable (a locale key) instead of fabricating an answer, and cites only authorized evidence. Factual accuracy of a real model needs the opt-in provider evaluation.' },
    { id: 'LLM10', title: 'Unbounded Consumption', scope: 'Budget reservations, mandate ceilings and windows, operator provider budgets without an overspend state, protection limits and negotiation round limits.' },
  ],
};

export const OWASP_AGENTIC_2026: OwaspFramework = {
  id: 'owasp-agentic-2026',
  title: 'OWASP Top 10 for Agentic Applications 2026',
  url: 'https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/',
  items: [
    { id: 'ASI01', title: 'Agent Goal Hijack', scope: 'Injected instructions in every untrusted channel that redirect the agent to other goals, counterparties or amounts; the policy decides on structured facts only.' },
    { id: 'ASI02', title: 'Tool Misuse and Exploitation', scope: 'Tools outside the mandate, malformed tool calls, payloads with private fields, loops of tool calls and capability declarations that would let a commit consume untrusted text.' },
    { id: 'ASI03', title: 'Identity and Privilege Abuse', scope: 'Another person\'s mandate, mandate widening through chat, agents, connections, modules, goals and extensions (proposal only), connections without bound mandates, governance never reachable by connections.' },
    { id: 'ASI04', title: 'Agentic Supply Chain Vulnerabilities', scope: 'Extension and module capability declarations that try to bypass mandates, budgets, confirmations or the untrusted-text rule; model routes and egress rules for third-party providers. The extension registry itself arrives with AGT-023 and reuses this harness.' },
    { id: 'ASI05', title: 'Unexpected Code Execution', scope: 'The runtime has no code, shell or query tool; a model asking for one is refused and nothing is executed. Output text containing markup or code is stored as inert content.' },
    { id: 'ASI06', title: 'Memory and Context Poisoning', scope: 'Poisoned conversation history and retrieved evidence that carry instructions; earlier turns never grant authority; retrieval is filtered by the person\'s audience.' },
    { id: 'ASI07', title: 'Insecure Inter-Agent Communication', scope: 'Agent envelopes: the note is always untrusted, state-moving intents need digest-pinned references, counterparty projections drop owner-only fields, representatives name the accountable person. Envelope delivery arrives with AGT-001; module suites register here.' },
    { id: 'ASI08', title: 'Cascading Failures', scope: 'Kill switches and the person stop block dispatch before the next check; budget exhaustion and windows stop runaway loops; unknown outcomes are reconciled, never replayed (tests/assistant/runtime.test.ts covers the reconciliation paths).' },
    { id: 'ASI09', title: 'Human-Agent Trust Exploitation', scope: 'Approvals bind the exact action digest and mandate revision; an approval cannot be replayed onto a changed payload; human-only verbs always ask; agents carry a disclosure label.' },
    { id: 'ASI10', title: 'Rogue Agents', scope: 'The person stop suspends every mandate and revokes waiting actions; releasing it reactivates nothing; the system may only narrow a mandate; a model has no tool to confirm, approve, widen or stop anything.' },
  ],
};

export const OWASP_FRAMEWORKS: readonly OwaspFramework[] = [OWASP_LLM_2025, OWASP_AGENTIC_2026];

export type OwaspId =
  | 'LLM01' | 'LLM02' | 'LLM03' | 'LLM04' | 'LLM05' | 'LLM06' | 'LLM07' | 'LLM08' | 'LLM09' | 'LLM10'
  | 'ASI01' | 'ASI02' | 'ASI03' | 'ASI04' | 'ASI05' | 'ASI06' | 'ASI07' | 'ASI08' | 'ASI09' | 'ASI10';

export const OWASP_IDS: ReadonlySet<string> = new Set(OWASP_FRAMEWORKS.flatMap((f) => f.items.map((i) => i.id)));
