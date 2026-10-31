'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Dialog } from '@trustwork/ui';
import { ArrowRight, ArrowUpRight, Check, Copy, FileText, Paperclip, RotateCcw, SendHorizonal, Sparkles, X } from 'lucide-react';
import { t } from '@/app/_lib/i18n';

/** Serialisable public summary of a project; the only knowledge the agent may use. */
export type ProjectBrief = {
  name: string;
  slug: string;
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

type Item = { label: string; meta?: string | undefined; href?: string | null | undefined };
type Action = { label: string; href: string; primary?: boolean };
type Purpose = 'offer' | 'participation' | 'materials' | 'other';
type Attachment = { name: string; size: number; purpose: Purpose };
type Message = { id: number; role: 'user' | 'agent'; text: string; items?: Item[]; chips?: string[]; sources?: Array<{ id: string; label: string }>; actions?: Action[]; followups?: string[]; attachments?: Attachment[] };
type Topic = 'about' | 'stage' | 'participants' | 'needs' | 'updates' | 'partners' | 'dates' | 'media' | 'publications' | 'passport' | 'materials' | 'commercial' | 'documents';

const PURPOSES: Purpose[] = ['offer', 'participation', 'materials', 'other'];
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,application/pdf,image/*';
const MAX_SIZE = 10 * 1024 * 1024;
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
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

function answer(brief: ProjectBrief, q: string, id: number): Message {
  const questions = Array.from({ length: 11 }, (_, i) => t(`projectPage.agentQuestions.${i}` as 'projectPage.agentQuestions.0'));
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

const OPEN_EVENT = 'project-agent:open';

export function ProjectAgentTrigger({ question, className, children }: { question?: string | undefined; className?: string | undefined; children: React.ReactNode }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { question } }))}>
      {children}
    </button>
  );
}

function useTypewriter(text: string, enabled: boolean): string {
  const [shown, setShown] = useState(enabled ? '' : text);
  useEffect(() => {
    if (!enabled) {
      setShown(text);
      return;
    }
    const words = text.split(' ');
    let i = 0;
    setShown('');
    const timer = window.setInterval(() => {
      i += 2;
      setShown(words.slice(0, i).join(' '));
      if (i >= words.length) window.clearInterval(timer);
    }, 28);
    return () => window.clearInterval(timer);
  }, [text, enabled]);
  return shown;
}

function AgentBubble({ message, animate, onFollow, onClose }: { message: Message; animate: boolean; onFollow: (q: string) => void; onClose: () => void }) {
  const text = useTypewriter(message.text, animate);
  const done = text === message.text;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([message.text, ...(message.items ?? []).map((i) => `• ${i.label}${i.meta ? ` — ${i.meta}` : ''}`)].join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="cp-msg cp-msg--agent">
      <span className="cp-msg__avatar" aria-hidden="true">
        <Sparkles size={14} strokeWidth={2} />
      </span>
      <div className="cp-msg__col">
        <div className="cp-msg__bubble">
          <p>{text}</p>
          {done && message.items?.length ? (
            <ul className="cp-msg__items">
              {message.items.map((it, i) => (
                <li key={i}>
                  {it.href ? (
                    <a href={it.href} onClick={it.href.startsWith('#') ? onClose : undefined}>
                      <span className="cp-msg__item-label">{it.label}</span>
                      {it.meta ? <span className="cp-msg__item-meta">{it.meta}</span> : null}
                      <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                    </a>
                  ) : (
                    <span>
                      <span className="cp-msg__item-label">{it.label}</span>
                      {it.meta ? <span className="cp-msg__item-meta">{it.meta}</span> : null}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {done && (message.sources?.length || message.actions?.length) ? (
            <div className="cp-msg__foot">
              {message.sources?.map((s) => (
                <a key={s.id} href={`#${s.id}`} className="cp-msg__source" onClick={onClose}>
                  {t('companyPage.repOpen')}: {s.label}
                  <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
                </a>
              ))}
              {message.actions?.map((a) => (
                <a key={a.href + a.label} href={a.href} className={a.primary ? 'cp-msg__action cp-msg__action--primary' : 'cp-msg__action'}>
                  {a.label}
                </a>
              ))}
              <button type="button" className="cp-msg__copy" onClick={copy} aria-label={t('companyPage.agentCopy')} title={t('companyPage.agentCopy')}>
                {copied ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={2} aria-hidden="true" />}
              </button>
            </div>
          ) : null}
        </div>
        {done && message.followups?.length ? (
          <div className="cp-msg__follow">
            {message.followups.map((fq) => (
              <button key={fq} type="button" className="cp-chip" onClick={() => onFollow(fq)}>
                {fq}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Project agent (demo): answers from the public brief; accepts offers, participation requests and materials handed over after sign-in. */
export function ProjectAssistant({ brief }: { brief: ProjectBrief }) {
  const storageKey = `sr-project-agent:${brief.slug}`;
  const hello: Message = { id: 0, role: 'agent', text: t('projectPage.agentHello', { name: brief.name }) };
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([hello]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [animateId, setAnimateId] = useState<number | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seq = useRef(1);
  const questions = Array.from({ length: 11 }, (_, i) => t(`projectPage.agentQuestions.${i}` as 'projectPage.agentQuestions.0'));

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as Message[];
        if (Array.isArray(saved) && saved.length > 1) {
          setMessages(saved);
          seq.current = Math.max(...saved.map((m) => m.id)) + 1;
        }
      }
    } catch {
      /* ignore */
    }
  }, [storageKey]);
  useEffect(() => {
    try {
      if (messages.length > 1) window.sessionStorage.setItem(storageKey, JSON.stringify(messages));
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [messages, storageKey]);

  const ask = (q: string) => {
    const text = q.trim();
    if (!text || thinking) return;
    setMessages((m) => [...m, { id: seq.current++, role: 'user', text }]);
    setDraft('');
    setThinking(true);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(
      () => {
        const reply = answer(brief, text, seq.current++);
        setAnimateId(reduce ? null : reply.id);
        setMessages((m) => [...m, reply]);
        setThinking(false);
      },
      reduce ? 0 : 500,
    );
  };

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen(true);
      const q = (e as CustomEvent<{ question?: string }>).detail?.question;
      if (q) window.setTimeout(() => ask(q), 80);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [brief]);

  useEffect(() => {
    const list = listRef.current;
    const inner = innerRef.current;
    if (!list || !inner) return;
    const toBottom = () => {
      list.scrollTop = list.scrollHeight;
    };
    toBottom();
    const observer = new ResizeObserver(toBottom);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [open, messages, thinking]);
  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= 3) {
        setError(t('companyPage.attachTooMany'));
        break;
      }
      if (f.size > MAX_SIZE) {
        setError(t('companyPage.attachTooBig', { name: f.name }));
        continue;
      }
      const ok = /\.(pdf|docx?|xlsx?|png|jpe?g|webp)$/i.test(f.name) || f.type === 'application/pdf' || f.type.startsWith('image/');
      if (!ok) {
        setError(t('companyPage.attachBadType', { name: f.name }));
        continue;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setFiles(next);
    if (fileRef.current) fileRef.current.value = '';
  };
  const sendWithFiles = () => {
    if (!files.length || !purpose) return;
    const atts: Attachment[] = files.map((f) => ({ name: f.name, size: f.size, purpose }));
    setMessages((m) => [...m, { id: seq.current++, role: 'user', text: draft.trim(), attachments: atts }]);
    setFiles([]);
    setPurpose(null);
    setDraft('');
    setError(null);
    setThinking(true);
    window.setTimeout(() => {
      const reply: Message = {
        id: seq.current++,
        role: 'agent',
        text: `${t('projectPage.attachReceived', { count: atts.length, purpose: t(`projectPage.purposeFor.${purpose}`) })} ${t('projectPage.attachNext')}`,
        actions: [{ label: t('projectPage.attachLogin'), href: `${brief.writeHref}&kind=${purpose}`, primary: true }],
        followups: [questions[3]!, questions[5]!],
      };
      setAnimateId(reply.id);
      setMessages((m) => [...m, reply]);
      setThinking(false);
    }, 450);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (files.length) sendWithFiles();
    else ask(draft);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (files.length) sendWithFiles();
      else ask(draft);
    }
  };
  const reset = () => {
    setMessages([hello]);
    setAnimateId(null);
    setFiles([]);
    setPurpose(null);
    setError(null);
    inputRef.current?.focus();
  };
  const fresh = messages.length === 1;

  return (
    <Dialog title={t('projectPage.agentTitle', { name: brief.name })} isOpen={open} onOpenChange={setOpen} size="md" className="cp-agent-dialog">
      <div className="cp-chat">
        <div className="cp-chat__status">
          <span className="cp-chat__dot" aria-hidden="true" />
          {t('projectPage.agentStatus')}
          <button type="button" className="cp-chat__reset" onClick={reset} disabled={fresh}>
            <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
            {t('companyPage.agentReset')}
          </button>
        </div>
        <div className="cp-chat__list" ref={listRef} role="log" aria-live="polite">
          <div className="cp-chat__inner" ref={innerRef}>
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="cp-msg cp-msg--user">
                  <div className="cp-msg__bubble">
                    {m.text ? <p>{m.text}</p> : null}
                    {m.attachments?.length ? (
                      <ul className="cp-files cp-files--sent">
                        {m.attachments.map((f, i) => (
                          <li key={i} className="cp-file">
                            <FileText size={16} strokeWidth={2} aria-hidden="true" />
                            <span className="cp-file__text">
                              <span className="cp-file__name">{f.name}</span>
                              <span className="cp-file__meta">
                                {fmtSize(f.size)} · {t(`projectPage.purpose.${f.purpose}`)} · {t('companyPage.attachDraft')}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ) : (
                <AgentBubble key={m.id} message={m} animate={animateId === m.id} onFollow={ask} onClose={() => setOpen(false)} />
              ),
            )}
            {thinking ? (
              <div className="cp-msg cp-msg--agent" aria-hidden="true">
                <span className="cp-msg__avatar">
                  <Sparkles size={14} strokeWidth={2} />
                </span>
                <div className="cp-msg__bubble cp-msg__bubble--typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            ) : null}
            {fresh ? (
              <div className="cp-chat__starter">
                <p className="cp-chat__starter-title">{t('companyPage.agentStarter')}</p>
                <div className="cp-chat__chips">
                  {questions.slice(0, 6).map((q) => (
                    <button key={q} type="button" className="cp-chip" onClick={() => ask(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <form className="cp-chat__form" onSubmit={submit}>
          {files.length ? (
            <div className="cp-chat__attach">
              <ul className="cp-files">
                {files.map((f) => (
                  <li key={`${f.name}-${f.size}`} className="cp-file">
                    <FileText size={16} strokeWidth={2} aria-hidden="true" />
                    <span className="cp-file__text">
                      <span className="cp-file__name">{f.name}</span>
                      <span className="cp-file__meta">{fmtSize(f.size)}</span>
                    </span>
                    <button type="button" className="cp-file__remove" aria-label={t('companyPage.attachRemove')} onClick={() => setFiles(files.filter((x) => x !== f))}>
                      <X size={14} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="cp-chat__purpose" role="radiogroup" aria-label={t('companyPage.attachPurpose')}>
                <span className="cp-chat__purpose-label">{t('companyPage.attachPurpose')}</span>
                {PURPOSES.map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={purpose === p} className={purpose === p ? 'cp-chip cp-chip--on' : 'cp-chip'} onClick={() => setPurpose(p)}>
                    {t(`projectPage.purpose.${p}`)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {error ? (
            <p className="cp-chat__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="cp-chat__row">
            <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => addFiles(e.target.files)} />
            <button type="button" className="cp-chat__clip" aria-label={t('companyPage.attach')} title={t('companyPage.attachHint')} onClick={() => fileRef.current?.click()}>
              <Paperclip size={18} strokeWidth={2} aria-hidden="true" />
            </button>
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder={files.length ? t('companyPage.attachSend') : t('companyPage.repPlaceholder')}
              aria-label={t('companyPage.repPlaceholder')}
              autoComplete="off"
              enterKeyHint="send"
            />
            <button type="submit" className="cp-chat__send" disabled={thinking || (files.length ? !purpose : !draft.trim())} aria-label={t('companyPage.repSend')}>
              <SendHorizonal size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
