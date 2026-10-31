'use client';

import { t } from '@/app/_lib/i18n';
import { PublicAssistant } from './PublicAssistant';
import type { AgentAction, AgentAttachment, AgentMessage, AgentProfile } from './types';

/** Serialisable public summary of a company; the only knowledge the agent may use. */
export type CompanyBrief = {
  name: string;
  handle: string;
  description: string | null;
  roles: string[];
  directions: string[];
  region: string;
  geography: string[];
  statusLabel: string;
  statusHint: string;
  identifier: string;
  domain: string;
  certificates: Array<{ name: string; evidence: string }>;
  signals: string[];
  projects: Array<{ name: string; status: string; href: string; summary: string | null }>;
  catalogue: { version: string; entries: Array<{ name: string; kind: string; unit: string }> } | null;
  people: Array<{ name: string; role: string; href: string }>;
  contacts: Array<{ label: string; value: string; href: string | null }>;
  vacancies: Array<{ title: string; location: string; salary: string; href: string }>;
  updates: Array<{ date: string; title: string; href: string | null }>;
  faq: Array<{ q: string; a: string }>;
  quoteHref: string;
  website: string | null;
};

type Purpose = 'resume' | 'offer' | 'request' | 'other';
type Message = AgentMessage<Purpose>;
type Action = AgentAction;
const PURPOSES: Purpose[] = ['resume', 'offer', 'request', 'other'];
type Topic = 'about' | 'projects' | 'products' | 'contacts' | 'documents' | 'team' | 'vacancies' | 'updates' | 'status';

const TOPICS: Topic[] = ['status', 'projects', 'products', 'contacts', 'documents', 'team', 'vacancies', 'updates', 'about'];
/** Keyword stems per topic come from the dictionary (`companyPage.intentWords.<topic>`, `|`-separated), so matching follows the active language. */
const intents = (): Array<{ id: Topic; words: string[] }> =>
  TOPICS.map((id) => ({ id, words: t(`companyPage.intentWords.${id}` as 'companyPage.intentWords.about').split('|').map((w) => w.trim().toLocaleLowerCase()).filter(Boolean) }));
const SECTION: Record<Topic, string> = {
  status: 'overview',
  about: 'overview',
  projects: 'projects',
  products: 'products',
  contacts: 'contacts',
  documents: 'documents',
  team: 'team',
  vacancies: 'vacancies',
  updates: 'updates',
};
const FOLLOW: Record<Topic, Topic[]> = {
  status: ['vacancies', 'products', 'contacts'],
  about: ['projects', 'products', 'contacts'],
  projects: ['products', 'team', 'documents'],
  products: ['contacts', 'projects', 'documents'],
  contacts: ['products', 'vacancies', 'about'],
  documents: ['projects', 'contacts', 'about'],
  team: ['vacancies', 'projects', 'contacts'],
  vacancies: ['team', 'about', 'contacts'],
  updates: ['projects', 'products', 'contacts'],
};
const QUESTION_OF: Record<Topic, number> = { status: 4, about: 0, projects: 1, products: 2, contacts: 3, documents: 4, vacancies: 5, team: 6, updates: 7 };

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

function detect(q: string): Topic | null {
  const text = norm(q);
  for (const intent of intents()) if (intent.words.some((w) => text.includes(w))) return intent.id;
  return null;
}

/** Suggested questions in the active language (starters and follow-ups). */
const questionsOf = () => Array.from({ length: 8 }, (_, i) => t(`companyPage.repQuestions.${i}` as 'companyPage.repQuestions.0'));

/** Deterministic answer from the brief: no model, no data beyond the public page. */
function answer(brief: CompanyBrief, q: string, id: number): Message {
  const questions = questionsOf();
  const followups = (topic: Topic) => FOLLOW[topic].map((f) => questions[QUESTION_OF[f]]!).filter((fq) => norm(fq) !== norm(q));
  const src = (topic: Topic) => [{ id: SECTION[topic], label: t(`companyPage.nav.${SECTION[topic]}` as 'companyPage.nav.overview') }];
  const quote: Action = { label: t('companyPage.requestQuote'), href: brief.quoteHref, primary: true };

  const standard = questions.some((sq) => norm(sq) === norm(q));
  const faq = standard
    ? undefined
    : brief.faq.find((f) => {
        const a = norm(f.q);
        const words = norm(q)
          .split(/\s+/)
          .filter((w) => w.length > 3);
        return words.length > 0 && words.filter((w) => a.includes(w.slice(0, 5))).length >= Math.min(2, words.length);
      });
  if (faq) return { id, role: 'agent', text: faq.a, sources: [{ id: 'overview', label: t('companyPage.faqTitle') }], followups: followups('about') };

  const topic = detect(q);
  switch (topic) {
    case 'about': {
      const places = brief.geography.length ? brief.geography : [brief.region];
      return {
        id,
        role: 'agent',
        text: t('companyPage.agent.about', { name: brief.name, roles: brief.roles.join(', ').toLowerCase(), region: places.join(', ') }) + (brief.description ? ` ${brief.description}` : ''),
        chips: brief.directions,
        sources: src('about'),
        followups: followups('about'),
      };
    }
    case 'status':
      return brief.signals.length
        ? { id, role: 'agent', text: t('companyPage.agent.signals'), items: brief.signals.map((x) => ({ label: x })), sources: src('status'), actions: [quote], followups: followups('status') }
        : { id, role: 'agent', text: t('companyPage.agent.signalsNone'), actions: [quote], followups: followups('status') };
    case 'projects':
      return brief.projects.length
        ? {
            id,
            role: 'agent',
            text: t('companyPage.agent.projects', { count: brief.projects.length }),
            items: brief.projects.map((p) => ({ label: p.name, meta: p.status, href: p.href })),
            sources: src('projects'),
            followups: followups('projects'),
          }
        : { id, role: 'agent', text: t('companyPage.repAnswers.projectsNone'), sources: src('projects'), actions: [quote], followups: followups('projects') };
    case 'products':
      return brief.catalogue && brief.catalogue.entries.length
        ? {
            id,
            role: 'agent',
            text: t('companyPage.agent.catalogue', { count: brief.catalogue.entries.length, version: brief.catalogue.version }),
            items: brief.catalogue.entries.map((e) => ({ label: e.name, meta: `${e.kind} · ${e.unit}`, href: '#products' })),
            sources: src('products'),
            actions: [quote],
            followups: followups('products'),
          }
        : { id, role: 'agent', text: t('companyPage.repAnswers.catalogueNone'), sources: src('products'), actions: [quote], followups: followups('products') };
    case 'contacts':
      return brief.contacts.length
        ? {
            id,
            role: 'agent',
            text: t('companyPage.agent.contacts'),
            items: brief.contacts.map((c) => ({ label: c.value, meta: c.label, href: c.href })),
            sources: src('contacts'),
            actions: [quote],
            followups: followups('contacts'),
          }
        : { id, role: 'agent', text: t('companyPage.repAnswers.contactsNone'), sources: src('contacts'), actions: [quote], followups: followups('contacts') };
    case 'documents':
      return {
        id,
        role: 'agent',
        text: t('companyPage.agent.status', { status: brief.statusLabel.toLowerCase(), hint: brief.statusHint }),
        items: [
          { label: brief.identifier, meta: t('companyPage.identifier') },
          { label: brief.domain, meta: t('companyPage.domain') },
          ...brief.certificates.map((c) => ({ label: c.name, meta: c.evidence, href: '#documents' })),
        ],
        sources: src('documents'),
        followups: followups('documents'),
      };
    case 'team':
      return brief.people.length
        ? {
            id,
            role: 'agent',
            text: t('companyPage.agent.team', { count: brief.people.length }),
            items: brief.people.map((p) => ({ label: p.name, meta: p.role, href: p.href })),
            sources: src('team'),
            followups: followups('team'),
          }
        : { id, role: 'agent', text: t('companyPage.repAnswers.teamNone'), sources: src('team'), followups: followups('team') };
    case 'vacancies':
      return brief.vacancies.length
        ? {
            id,
            role: 'agent',
            text: t('companyPage.agent.vacancies', { count: brief.vacancies.length }),
            items: brief.vacancies.map((v) => ({ label: v.title, meta: `${v.location} · ${v.salary}`, href: v.href })),
            sources: src('vacancies'),
            followups: followups('vacancies'),
          }
        : { id, role: 'agent', text: t('companyPage.repAnswers.vacanciesNone'), sources: src('vacancies'), followups: followups('vacancies') };
    case 'updates':
      return brief.updates.length
        ? {
            id,
            role: 'agent',
            text: t('companyPage.agent.updates'),
            items: brief.updates.slice(0, 4).map((u) => ({ label: u.title, meta: u.date, href: u.href })),
            sources: src('updates'),
            followups: followups('updates'),
          }
        : { id, role: 'agent', text: t('companyPage.repAnswers.updatesNone'), sources: src('updates'), followups: followups('updates') };
    default:
      return { id, role: 'agent', text: t('companyPage.repFallback'), actions: [quote], followups: [questions[0]!, questions[2]!, questions[3]!] };
  }
}


/** Confirms the hand-over: the attachments wait as a draft until the visitor signs in. */
function confirmHandoff(brief: CompanyBrief, atts: AgentAttachment<Purpose>[], vacancy: string | undefined, id: number, questions: string[]): Message {
  const kind = atts[0]?.purpose ?? 'other';
  const label = vacancy ? ` «${vacancy}»` : '';
  const loginHref = `/login?next=${encodeURIComponent(`/app/messages/new?company=${brief.handle}&kind=${kind}`)}`;
  return {
    id,
    role: 'agent',
    text: `${t('companyPage.attachReceived', { count: atts.length, purpose: t(`companyPage.purposeFor.${kind}`), vacancy: label })} ${t('companyPage.attachNext')}`,
    actions: [
      { label: t('companyPage.attachLogin'), href: loginHref, primary: true },
      { label: t('companyPage.requestQuote'), href: brief.quoteHref },
    ],
    followups: [questions[3]!, questions[0]!],
  };
}

/** Company agent: answers about the company's public page; a resume for a company with several vacancies first asks which one. */
export const companyAgent: AgentProfile<CompanyBrief, Purpose> = {
  kind: 'company',
  storagePrefix: 'sr-agent:',
  questions: questionsOf,
  title: (brief) => t('companyPage.agentTitle', { name: brief.name }),
  hello: (brief) => t('companyPage.repHello', { name: brief.name }),
  status: () => t('companyPage.agentStatus'),
  purposes: PURPOSES,
  purposeLabel: (purpose) => t(`companyPage.purpose.${purpose}`),
  answer,
  handoff: (brief, atts, purpose, nextId, questions) => {
    if (purpose === 'resume' && brief.vacancies.length > 1)
      return {
        reply: {
          id: nextId(),
          role: 'agent',
          text: t('companyPage.attachWhichVacancy'),
          pick: [...brief.vacancies.map((v) => ({ label: v.title, value: v.title })), { label: t('companyPage.attachNoVacancy'), value: '__none__' }],
        },
        pending: atts,
      };
    const first = purpose === 'resume' ? brief.vacancies[0] : undefined;
    return { reply: confirmHandoff(brief, first ? atts.map((f) => ({ ...f, vacancy: first.title })) : atts, first?.title, nextId(), questions) };
  },
  pick: (brief, pending, value, nextId, questions) => {
    const title = value === '__none__' ? undefined : value;
    return {
      label: title ?? t('companyPage.attachNoVacancy'),
      reply: () =>
        confirmHandoff(
          brief,
          pending.map((f) => ({ ...f, vacancy: title })),
          title,
          nextId(),
          questions,
        ),
    };
  },
};

/** The company page's agent dialog (`PublicAssistant` bound to `companyAgent`); opens from `AgentTrigger kind="company"`. */
export function CompanyAssistant({ brief }: { brief: CompanyBrief }) {
  return <PublicAssistant profile={companyAgent} brief={brief} />;
}
