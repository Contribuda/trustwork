'use client';

import { t } from '@/app/_lib/i18n';
import { PublicAssistant } from './PublicAssistant';
import type { AgentAction, AgentMessage, AgentProfile } from './types';

/** Serialisable public summary of a person; the only knowledge the agent may use. */
export type PersonBrief = {
  name: string;
  handle: string;
  role: string;
  field: string;
  independent: boolean;
  employer: { name: string; href: string } | null;
  about: string | null;
  expertise: string[];
  geography: string[];
  signals: Array<{ label: string; note: string | null }>;
  services: Array<{ name: string; description: string | null; format: string }>;
  portfolio: Array<{ title: string; kind: string; year: number | null; href: string | null }>;
  career: Array<{ role: string; company: string; years: string; href: string | null }>;
  certificates: Array<{ name: string; evidence: string }>;
  projects: Array<{ name: string; status: string; href: string }>;
  publications: Array<{ title: string; href: string; date: string }>;
  contacts: Array<{ label: string; value: string; href: string | null }>;
  documents: string[];
  faq: Array<{ q: string; a: string }>;
  messageHref: string;
};

type Purpose = 'projectOffer' | 'jobOffer' | 'request' | 'other';
type Message = AgentMessage<Purpose>;
type Action = AgentAction;
type Topic = 'about' | 'services' | 'portfolio' | 'status' | 'experience' | 'contacts' | 'projects' | 'publications' | 'documents';

const PURPOSES: Purpose[] = ['projectOffer', 'jobOffer', 'request', 'other'];
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

const INTENTS: Array<{ id: Topic; words: string[] }> = [
  { id: 'status', words: ['свободн', 'доступ', 'статус', 'готов', 'занят', 'ищет', 'ищешь', 'нанима', 'открыт к', 'когда может'] },
  { id: 'services', words: ['услуг', 'предлага', 'цена', 'стоим', 'сколько', 'заказать', 'консультац', 'что делает за деньги'] },
  { id: 'portfolio', words: ['портфолио', 'работы', 'примеры', 'что сделал', 'что сделала', 'объекты', 'кейс'] },
  { id: 'experience', words: ['опыт', 'карьер', 'где работал', 'где работала', 'стаж', 'образован', 'учил', 'биограф'] },
  { id: 'contacts', words: ['контакт', 'связ', 'телефон', 'почт', 'email', 'telegram', 'написать', 'позвонить'] },
  { id: 'projects', words: ['проект', 'участву'] },
  { id: 'publications', words: ['публикац', 'стать', 'пишет', 'написал', 'написала', 'материал'] },
  { id: 'documents', words: ['подтвержд', 'допуск', 'удостовер', 'сертификат', 'довер', 'провер', 'согласи'] },
  { id: 'about', words: ['чем занима', 'кто', 'расскаж', 'о себе', 'специализ', 'направлен', 'регион', 'географ', 'привет', 'здравств'] },
];
const SECTION: Record<Topic, string> = {
  about: 'overview',
  services: 'services',
  portfolio: 'portfolio',
  status: 'overview',
  experience: 'experience',
  contacts: 'contacts',
  projects: 'projects',
  publications: 'publications',
  documents: 'documents',
};
const FOLLOW: Record<Topic, number[]> = {
  about: [3, 1, 5],
  services: [3, 2, 5],
  portfolio: [1, 4, 5],
  status: [1, 5, 4],
  experience: [2, 7, 5],
  contacts: [1, 3, 0],
  projects: [2, 4, 5],
  publications: [0, 4, 5],
  documents: [4, 3, 5],
};

function detect(q: string): Topic | null {
  const text = norm(q);
  for (const i of INTENTS) if (i.words.some((w) => text.includes(w))) return i.id;
  return null;
}

/** Suggested questions in the active language (starters and follow-ups). */
const questionsOf = () => Array.from({ length: 8 }, (_, i) => t(`personPage.agentQuestions.${i}` as 'personPage.agentQuestions.0'));

function answer(brief: PersonBrief, q: string, id: number): Message {
  const questions = questionsOf();
  const follow = (topic: Topic) => FOLLOW[topic].map((i) => questions[i]!).filter((fq) => norm(fq) !== norm(q));
  const src = (topic: Topic) => [{ id: SECTION[topic], label: t(`personPage.nav.${SECTION[topic]}` as 'personPage.nav.overview') }];
  const write: Action = { label: t('personPage.writeLogin'), href: brief.messageHref, primary: true };
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
  if (faq) return { id, role: 'agent', text: faq.a, sources: [{ id: 'overview', label: t('personPage.faqTitle') }], followups: follow('about') };
  const topic = detect(q);
  switch (topic) {
    case 'about':
      return {
        id,
        role: 'agent',
        text:
          t('personPage.agent.about', {
            name: brief.name,
            role: brief.role,
            field: brief.independent ? t('personPage.independent') : `${t('personPage.worksAt')} ${brief.employer?.name ?? ''}`,
            geo: brief.geography.join(', '),
          }) + (brief.about ? ` ${brief.about.split('\n')[0]}` : ''),
        chips: brief.expertise,
        sources: src('about'),
        followups: follow('about'),
      };
    case 'services':
      return brief.services.length
        ? {
            id,
            role: 'agent',
            text: t('personPage.agent.services', { count: brief.services.length }),
            items: brief.services.map((s) => ({ label: s.name, meta: s.format, href: '#services' })),
            sources: src('services'),
            actions: [write],
            followups: follow('services'),
          }
        : { id, role: 'agent', text: t('personPage.agent.servicesNone'), actions: [write], followups: follow('services') };
    case 'portfolio':
      return brief.portfolio.length
        ? {
            id,
            role: 'agent',
            text: t('personPage.agent.portfolio', { count: brief.portfolio.length }),
            items: brief.portfolio.map((w) => ({ label: w.title, meta: [w.kind, w.year].filter(Boolean).join(' · '), href: w.href ?? '#portfolio' })),
            sources: src('portfolio'),
            followups: follow('portfolio'),
          }
        : { id, role: 'agent', text: t('personPage.agent.portfolioNone'), followups: follow('portfolio') };
    case 'status':
      return brief.signals.length
        ? { id, role: 'agent', text: t('personPage.agent.status'), items: brief.signals.map((s) => ({ label: s.label, meta: s.note ?? undefined })), sources: src('status'), actions: [write], followups: follow('status') }
        : { id, role: 'agent', text: t('personPage.agent.statusNone'), actions: [write], followups: follow('status') };
    case 'experience':
      return brief.career.length
        ? {
            id,
            role: 'agent',
            text: t('personPage.agent.experience'),
            items: brief.career.map((c) => ({ label: `${c.role} — ${c.company}`, meta: c.years, href: c.href })),
            sources: src('experience'),
            followups: follow('experience'),
          }
        : { id, role: 'agent', text: t('personPage.agent.experienceNone'), followups: follow('experience') };
    case 'contacts':
      return brief.contacts.length
        ? {
            id,
            role: 'agent',
            text: t('personPage.agent.contacts'),
            items: brief.contacts.map((c) => ({ label: c.value, meta: c.label, href: c.href })),
            sources: src('contacts'),
            actions: [write],
            followups: follow('contacts'),
          }
        : { id, role: 'agent', text: t('personPage.agent.contactsNone'), actions: [write], followups: follow('contacts') };
    case 'projects':
      return brief.projects.length
        ? {
            id,
            role: 'agent',
            text: t('personPage.agent.projects', { count: brief.projects.length }),
            items: brief.projects.map((p) => ({ label: p.name, meta: p.status, href: p.href })),
            sources: src('projects'),
            followups: follow('projects'),
          }
        : { id, role: 'agent', text: t('personPage.agent.projectsNone'), followups: follow('projects') };
    case 'publications':
      return brief.publications.length
        ? {
            id,
            role: 'agent',
            text: t('personPage.agent.publications'),
            items: brief.publications.slice(0, 5).map((p) => ({ label: p.title, meta: p.date, href: p.href })),
            sources: src('publications'),
            followups: follow('publications'),
          }
        : { id, role: 'agent', text: t('personPage.agent.publicationsNone'), followups: follow('publications') };
    case 'documents':
      return {
        id,
        role: 'agent',
        text: t('personPage.agent.documents'),
        items: [...brief.documents.map((d) => ({ label: d })), ...brief.certificates.map((c) => ({ label: c.name, meta: c.evidence, href: '#documents' }))],
        sources: src('documents'),
        followups: follow('documents'),
      };
    default:
      return { id, role: 'agent', text: t('personPage.agent.fallback'), actions: [write], followups: [questions[0]!, questions[3]!, questions[5]!] };
  }
}


/** Person's agent: answers about the public profile; accepts project or job offers and requests handed over after sign-in. */
export const personAgent: AgentProfile<PersonBrief, Purpose> = {
  kind: 'person',
  storagePrefix: 'sr-person-agent:',
  questions: questionsOf,
  title: (brief) => t('personPage.agentTitle', { name: brief.name }),
  hello: (brief) => t('personPage.agentHello', { name: brief.name }),
  status: () => t('personPage.agentStatus'),
  purposes: PURPOSES,
  purposeLabel: (purpose) => t(`personPage.purpose.${purpose}`),
  answer,
  handoff: (brief, atts, purpose, nextId, questions) => ({
    reply: {
      id: nextId(),
      role: 'agent',
      text: `${t('personPage.attachReceived', { count: atts.length, purpose: t(`personPage.purposeFor.${purpose}`), name: brief.name })} ${t('personPage.attachNext')}`,
      actions: [{ label: t('personPage.attachLogin'), href: `${brief.messageHref}&kind=${purpose}`, primary: true }],
      followups: [questions[3]!, questions[5]!],
    },
  }),
};

/** The person page's agent dialog (`PublicAssistant` bound to `personAgent`); opens from `AgentTrigger kind="person"`. */
export function PersonAssistant({ brief }: { brief: PersonBrief }) {
  return <PublicAssistant profile={personAgent} brief={brief} />;
}
