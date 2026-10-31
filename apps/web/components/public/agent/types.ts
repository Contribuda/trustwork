/**
 * Shared shapes of the public entity agents (company, person, project). The agents are demo surfaces: each
 * answers deterministically from a serializable public brief built by the page, with no model and no data
 * beyond what the public page already shows.
 */

export type AgentKind = 'company' | 'person' | 'project';

export type AgentItem = { label: string; meta?: string | undefined; href?: string | null | undefined };
export type AgentAction = { label: string; href: string; primary?: boolean };
export type AgentAttachment<P extends string = string> = { name: string; size: number; purpose: P; vacancy?: string | undefined };

export type AgentMessage<P extends string = string> = {
  id: number;
  role: 'user' | 'agent';
  text: string;
  items?: AgentItem[];
  chips?: string[];
  sources?: Array<{ id: string; label: string }>;
  actions?: AgentAction[];
  followups?: string[];
  attachments?: AgentAttachment<P>[];
  /** Choices the person picks from before a hand-over continues (for example, which vacancy a resume is for). */
  pick?: Array<{ label: string; value: string }>;
};

/** Every brief carries the display name and the public handle (conversation storage is keyed by it). */
export type BaseBrief = { name: string; handle: string };

/** Ids are allocated in order by the dialog; profiles take the next one when they create a message. */
export type NextId = () => number;

/** Result of handing attachments to the agent: the agent's reply and, when it asked a `pick` question, the attachments waiting for the answer. */
export type HandoffStep<P extends string> = { reply: AgentMessage<P>; pending?: AgentAttachment<P>[] };

/**
 * Everything that differs between the company, person and project agents. The dialog (`PublicAssistant`) is
 * shared; a profile supplies the copy, the purposes of attachments, the answer engine and the hand-over.
 */
export type AgentProfile<B extends BaseBrief, P extends string> = {
  kind: AgentKind;
  /** sessionStorage key prefix; the conversation persists per entity (`<prefix><handle>`). */
  storagePrefix: string;
  /** Suggested questions in the active language; the first six are the starters. */
  questions: () => string[];
  title: (brief: B) => string;
  hello: (brief: B) => string;
  status: () => string;
  purposes: readonly P[];
  purposeLabel: (purpose: P) => string;
  answer: (brief: B, question: string, id: number) => AgentMessage<P>;
  /** Attachments sent with a purpose: the agent confirms the hand-over or asks a `pick` question first. */
  handoff: (brief: B, attachments: AgentAttachment<P>[], purpose: P, nextId: NextId, questions: string[]) => HandoffStep<P>;
  /** Answer to a `pick` question: the label shown as the person's message and the agent's reply. */
  pick?: (brief: B, pending: AgentAttachment<P>[], value: string, nextId: NextId, questions: string[]) => { label: string; reply: () => AgentMessage<P> };
};

/** Window event that opens an agent dialog, optionally with a question (`AgentTrigger`). */
export const openEventOf = (kind: AgentKind) => `${kind}-agent:open`;
