'use client';

import { t } from '@/app/_lib/i18n';
import { PublicAssistant } from './PublicAssistant';
import type { AgentAction, AgentMessage, AgentProfile } from './types';

/** Serialisable public summary of a project; the only knowledge the agent may use. */
export type ProjectBrief = {
  name: string;
  handle: string;
  category: string;
  region: string;
  status: string;
  owner: { label: string; href: string | null };
  story: string | null;
  highlights: Array<{ label: string; value: string }>;
  progress: { percent: number; done: number; total: number; current: string | null; nextDue: string | null; started: string };
  milestones: Array<{ title: string; state: string; date: string }>;
  participants: Array<{ label: string; role: string; href: string | null }>;
  needs: Array<{ title: string; kind: string; deadline: string; summary: string | null }>;
  updates: Array<{ title: string; date: string; type: string }>;
  plans: Array<{ title: string; when: string }>;
  partnerNote: string | null;
  contact: { label: string; href: string | null } | null;
  photos: number;
  files: number;
  publications: Array<{ title: string; href: string }>;
  passport: { type: string; address: string } | null;
  materials: Array<{ name: string; supplier: string | null; status: string }>;
  plan: Array<{ title: string; when: string; status: string }>;
  commercial: { offering: string; items: Array<{ title: string; detail: string | null }> } | null;
  documents: Array<{ name: string; kind: string; evidence: string }>;
  openRoles: Array<{ title: string; when: string | null }>;
  respondHref: string;
  writeHref: string;
};

type Purpose = 'offer' | 'participation' | 'materials' | 'other';
type Message = AgentMessage<Purpose>;
type Action = AgentAction;
type Topic = 'about' | 'stage' | 'participants' | 'needs' | 'updates' | 'partners' | 'dates' | 'media' | 'publications' | 'passport' | 'materials' | 'commercial' | 'documents';

const PURPOSES: Purpose[] = ['offer', 'participation', 'materials', 'other'];
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

const INTENTS: Array<{ id: Topic; words: string[] }> = [
  { id: 'commercial', words: ['продаёт', 'продает', 'купить', 'квартир', 'аренд', 'сдаёт', 'сдает', 'коммерческ', 'покупател', 'клиент', 'цена', 'стоимост'] },
  { id: 'documents', words: ['разрешен', 'документ', 'экспертиз', 'согласован', 'договор', 'лиценз'] },
  { id: 'passport', words: ['паспорт', 'адрес', 'площад', 'этаж', 'тип объекта', 'где наход', 'характеристик'] },
  { id: 'materials', words: ['материал', 'применя', 'подсистем', 'утеплител', 'панел', 'из чего', 'график закуп', 'закупк'] },
  { id: 'needs', words: ['нужно', 'потребност', 'запрос', 'ищете', 'ищет', 'закуп', 'поставщик', 'материал', 'тендер', 'предложен'] },
  { id: 'partners', words: ['партн', 'участв', 'присоедин', 'стать', 'условия', 'сотруднич', 'подрядчик'] },
  { id: 'stage', words: ['этап', 'стади', 'готовност', 'ход', 'прогресс', 'как идёт', 'как идет', 'статус', 'дорожн'] },
  { id: 'dates', words: ['срок', 'когда', 'дата', 'заверш', 'сдач', 'график', 'перенос'] },
  { id: 'participants', words: ['кто', 'участник', 'команд', 'владелец', 'заказчик', 'генподряд', 'руковод'] },
  { id: 'updates', words: ['новост', 'обновлен', 'что нового', 'последн', 'событ', 'результат'] },
  { id: 'media', words: ['фото', 'видео', 'файл', 'документ', 'материалы проекта', 'презентац', 'схем'] },
  { id: 'publications', words: ['публикац', 'стать', 'пишут', 'истори'] },
  { id: 'about', words: ['что это', 'о проекте', 'расскаж', 'какой проект', 'где', 'регион', 'что строит', 'привет', 'здравств', 'параметр', 'площад'] },
];
const SECTION: Record<Topic, string> = {
  passport: 'overview',
  materials: 'needs',
  commercial: 'clients',
  documents: 'documents',
  about: 'overview',
  stage: 'roadmap',
  dates: 'roadmap',
  participants: 'participants',
  needs: 'needs',
  updates: 'updates',
  media: 'media',
  partners: 'partners',
  publications: 'publications',
};
const FOLLOW: Record<Topic, number[]> = {
  passport: [1, 8, 10],
  materials: [3, 5, 1],
  commercial: [6, 0, 7],
  documents: [7, 2, 1],
  about: [1, 2, 3],
  stage: [6, 4, 3],
  dates: [1, 4, 5],
  participants: [5, 3, 1],
  needs: [5, 2, 1],
  updates: [1, 3, 7],
  media: [4, 2, 1],
  partners: [3, 2, 1],
  publications: [4, 0, 1],
};

function detect(q: string): Topic | null {
  const text = norm(q);
  for (const i of INTENTS) if (i.words.some((w) => text.includes(w))) return i.id;
  return null;
}

/** Suggested questions in the active language (starters and follow-ups). */
const questionsOf = () => Array.from({ length: 11 }, (_, i) => t(`projectPage.agentQuestions.${i}` as 'projectPage.agentQuestions.0'));

function answer(brief: ProjectBrief, q: string, id: number): Message {
  const questions = questionsOf();
  const follow = (topic: Topic) => FOLLOW[topic].map((i) => questions[i]!).filter((fq) => norm(fq) !== norm(q));
  const src = (topic: Topic) => [{ id: SECTION[topic], label: t(`projectPage.nav.${SECTION[topic]}` as 'projectPage.nav.overview') }];
  const respond: Action = { label: t('projectPage.respond'), href: brief.respondHref, primary: true };
  const write: Action = { label: t('projectPage.write'), href: brief.writeHref };
  const topic = detect(q);
  switch (topic) {
    case 'about':
      return {
        id,
        role: 'agent',
        text:
          t('projectPage.agent.about', { name: brief.name, category: brief.category, region: brief.region, owner: brief.owner.label, percent: brief.progress.percent }) +
          (brief.story ? ` ${brief.story.split('. ').slice(0, 2).join('. ')}.` : ''),
        items: brief.highlights.map((h) => ({ label: h.value, meta: h.label })),
        sources: src('about'),
        followups: follow('about'),
      };
    case 'stage':
      return brief.milestones.length
        ? {
            id,
            role: 'agent',
            text: t('projectPage.agent.stage', { percent: brief.progress.percent, done: brief.progress.done, total: brief.progress.total }),
            items: brief.milestones.map((m) => ({ label: m.title, meta: `${m.state} · ${m.date}`, href: '#roadmap' })),
            sources: src('stage'),
            followups: follow('stage'),
          }
        : { id, role: 'agent', text: t('projectPage.agent.stageNone'), followups: follow('stage') };
    case 'dates':
      return brief.progress.current
        ? {
            id,
            role: 'agent',
            text: t('projectPage.agent.dates', { start: brief.progress.started, stage: brief.progress.current, due: brief.progress.nextDue ?? '—' }),
            items: brief.plans.map((p) => ({ label: p.title, meta: p.when })),
            sources: src('dates'),
            followups: follow('dates'),
          }
        : { id, role: 'agent', text: t('projectPage.agent.datesNone'), followups: follow('dates') };
    case 'participants':
      return brief.participants.length
        ? {
            id,
            role: 'agent',
            text: t('projectPage.agent.participants'),
            items: brief.participants.map((p) => ({ label: p.label, meta: p.role, href: p.href })),
            sources: src('participants'),
            followups: follow('participants'),
          }
        : { id, role: 'agent', text: t('projectPage.agent.participantsNone'), followups: follow('participants') };
    case 'needs':
      return brief.needs.length
        ? {
            id,
            role: 'agent',
            text: t('projectPage.agent.needs'),
            items: brief.needs.map((n) => ({ label: n.title, meta: `${n.kind} · ${t('projectPage.needDeadline', { date: n.deadline })}`, href: '#needs' })),
            sources: src('needs'),
            actions: [respond],
            followups: follow('needs'),
          }
        : { id, role: 'agent', text: t('projectPage.agent.needsNone'), actions: [write], followups: follow('needs') };
    case 'updates':
      return brief.updates.length
        ? {
            id,
            role: 'agent',
            text: t('projectPage.agent.updates'),
            items: brief.updates.slice(0, 5).map((u) => ({ label: u.title, meta: `${u.date} · ${u.type}`, href: '#updates' })),
            sources: src('updates'),
            followups: follow('updates'),
          }
        : { id, role: 'agent', text: t('projectPage.agent.updatesNone'), followups: follow('updates') };
    case 'partners':
      return brief.partnerNote
        ? {
            id,
            role: 'agent',
            text: t('projectPage.agent.partners', { note: brief.partnerNote }),
            items: brief.contact ? [{ label: brief.contact.label, meta: t('projectPage.partnerContact'), href: brief.contact.href }] : [],
            sources: src('partners'),
            actions: brief.needs.length ? [respond, write] : [write],
            followups: follow('partners'),
          }
        : { id, role: 'agent', text: t('projectPage.agent.partnersNone'), actions: [write], followups: follow('partners') };
    case 'passport':
      return brief.passport
        ? {
            id,
            role: 'agent',
            text: t('projectPage.agent.passport', { type: brief.passport.type, address: brief.passport.address }),
            items: brief.highlights.map((h) => ({ label: h.value, meta: h.label })),
            sources: src('passport'),
            followups: follow('passport'),
          }
        : { id, role: 'agent', text: t('projectPage.agent.passportNone'), followups: follow('passport') };
    case 'materials':
      return brief.materials.length || brief.plan.length
        ? {
            id,
            role: 'agent',
            text: brief.materials.length ? t('projectPage.agent.materials') : t('projectPage.agent.plan'),
            items: [
              ...brief.materials.map((m) => ({ label: m.name, meta: [m.status, m.supplier].filter(Boolean).join(' · '), href: '#needs' })),
              ...brief.plan.map((p) => ({ label: p.title, meta: `${p.when} · ${p.status}`, href: '#needs' })),
            ],
            sources: src('materials'),
            followups: follow('materials'),
          }
        : { id, role: 'agent', text: t('projectPage.agent.materialsNone'), followups: follow('materials') };
    case 'commercial':
      return brief.commercial
        ? {
            id,
            role: 'agent',
            text: t('projectPage.agent.commercial', { offering: brief.commercial.offering }),
            items: brief.commercial.items.map((it) => ({ label: it.title, meta: it.detail ?? undefined, href: '#clients' })),
            sources: src('commercial'),
            actions: [{ label: t('projectPage.requestInfo'), href: `${brief.writeHref}%26kind%3Dclient`, primary: true }],
            followups: follow('commercial'),
          }
        : { id, role: 'agent', text: t('projectPage.agent.commercialNone'), actions: [write], followups: follow('commercial') };
    case 'documents':
      return brief.documents.length
        ? {
            id,
            role: 'agent',
            text: t('projectPage.agent.documents'),
            items: brief.documents.map((d) => ({ label: d.name, meta: `${d.kind} · ${d.evidence}`, href: '#documents' })),
            sources: src('documents'),
            followups: follow('documents'),
          }
        : { id, role: 'agent', text: t('projectPage.agent.documentsNone'), followups: follow('documents') };
    case 'media':
      return { id, role: 'agent', text: t('projectPage.agent.media', { photos: brief.photos, files: brief.files }), sources: src('media'), followups: follow('media') };
    case 'publications':
      return brief.publications.length
        ? { id, role: 'agent', text: t('projectPage.publicationsTitle') + ':', items: brief.publications.map((p) => ({ label: p.title, href: p.href })), sources: src('publications'), followups: follow('publications') }
        : { id, role: 'agent', text: t('projectPage.publicationsEmpty'), followups: follow('publications') };
    default:
      return { id, role: 'agent', text: t('projectPage.agent.fallback'), actions: [write], followups: [questions[0]!, questions[1]!, questions[3]!] };
  }
}


/** Project agent: answers about the public project page; accepts offers, participation requests and materials handed over after sign-in. */
export const projectAgent: AgentProfile<ProjectBrief, Purpose> = {
  kind: 'project',
  storagePrefix: 'sr-project-agent:',
  questions: questionsOf,
  title: (brief) => t('projectPage.agentTitle', { name: brief.name }),
  hello: (brief) => t('projectPage.agentHello', { name: brief.name }),
  status: () => t('projectPage.agentStatus'),
  purposes: PURPOSES,
  purposeLabel: (purpose) => t(`projectPage.purpose.${purpose}`),
  answer,
  handoff: (brief, atts, purpose, nextId, questions) => ({
    reply: {
      id: nextId(),
      role: 'agent',
      text: `${t('projectPage.attachReceived', { count: atts.length, purpose: t(`projectPage.purposeFor.${purpose}`) })} ${t('projectPage.attachNext')}`,
      actions: [{ label: t('projectPage.attachLogin'), href: `${brief.writeHref}&kind=${purpose}`, primary: true }],
      followups: [questions[3]!, questions[5]!],
    },
  }),
};

/** The project page's agent dialog (`PublicAssistant` bound to `projectAgent`); opens from `AgentTrigger kind="project"`. */
export function ProjectAssistant({ brief }: { brief: ProjectBrief }) {
  return <PublicAssistant profile={projectAgent} brief={brief} />;
}
