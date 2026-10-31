'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Dialog } from '@trustwork/ui';
import { ArrowRight, ArrowUpRight, Check, Copy, FileText, Paperclip, RotateCcw, SendHorizonal, Sparkles, X } from 'lucide-react';
import { t } from '@/app/_lib/i18n';
import { intlTag } from '@trustwork/ui/i18n';

/** Serialisable public summary of a company; the only knowledge the agent may use. */
export type CompanyBrief = {
  name: string;
  slug: string;
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

type Item = { label: string; meta?: string | undefined; href?: string | null | undefined };
type Action = { label: string; href: string; primary?: boolean };
type Attachment = { name: string; size: number; purpose: Purpose; vacancy?: string | undefined };
type Purpose = 'resume' | 'offer' | 'request' | 'other';
type Message = {
  id: number;
  role: 'user' | 'agent';
  text: string;
  items?: Item[];
  chips?: string[];
  sources?: Array<{ id: string; label: string }>;
  actions?: Action[];
  followups?: string[];
  attachments?: Attachment[];
  pick?: Array<{ label: string; value: string }>;
};
const PURPOSES: Purpose[] = ['resume', 'offer', 'request', 'other'];
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,application/pdf,image/*';
const MAX_SIZE = 10 * 1024 * 1024;
const fmtSize = (n: number) =>
  n >= 1024 * 1024
    ? new Intl.NumberFormat(intlTag(), { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(n / 1024 / 1024)
    : new Intl.NumberFormat(intlTag(), { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 }).format(Math.max(1, n / 1024));
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

/** Deterministic answer from the brief: no model, no data beyond the public page. */
function answer(brief: CompanyBrief, q: string, id: number): Message {
  const questions = Array.from({ length: 8 }, (_, i) => t(`companyPage.repQuestions.${i}` as 'companyPage.repQuestions.0'));
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

const OPEN_EVENT = 'company-agent:open';

/** Button that opens the agent dialog (optionally with a prefilled question); usable from server markup. */
export function AssistantTrigger({ question, className, children }: { question?: string | undefined; className?: string | undefined; children: React.ReactNode }) {
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

function AgentBubble({ message, animate, onFollow, onClose, onPick }: { message: Message; animate: boolean; onFollow: (q: string) => void; onClose: () => void; onPick: (value: string) => void }) {
  const text = useTypewriter(message.text, animate);
  const done = text === message.text;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([message.text, ...(message.items ?? []).map((i) => `• ${i.label}${i.meta ? ` — ${i.meta}` : ''}`)].join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: nothing to do */
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
          {done && message.chips?.length ? (
            <p className="cp-msg__chips">
              {message.chips.map((c) => (
                <span key={c} className="cp-msg__chip">
                  {c}
                </span>
              ))}
            </p>
          ) : null}
          {done && message.items?.length ? (
            <ul className="cp-msg__items">
              {message.items.map((it, i) => (
                <li key={i}>
                  {it.href ? (
                    <a
                      href={it.href}
                      onClick={it.href.startsWith('#') ? onClose : undefined}
                      target={it.href.startsWith('http') ? '_blank' : undefined}
                      rel={it.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                    >
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
                <a key={a.href} href={a.href} className={a.primary ? 'cp-msg__action cp-msg__action--primary' : 'cp-msg__action'}>
                  {a.label}
                </a>
              ))}
              <button type="button" className="cp-msg__copy" onClick={copy} aria-label={t('companyPage.agentCopy')} title={t('companyPage.agentCopy')}>
                {copied ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={2} aria-hidden="true" />}
              </button>
            </div>
          ) : null}
        </div>
        {done && message.pick?.length ? (
          <div className="cp-msg__follow">
            {message.pick.map((p) => (
              <button key={p.value} type="button" className="cp-chip cp-chip--accent" onClick={() => onPick(p.value)}>
                {p.label}
              </button>
            ))}
          </div>
        ) : null}
        {done && message.followups?.length ? (
          <div className="cp-msg__follow">
            {message.followups.map((q) => (
              <button key={q} type="button" className="cp-chip" onClick={() => onFollow(q)}>
                {q}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Company agent (demo). A chat dialog that answers from the public brief only: structured lists with links,
 * the section each answer comes from, quick actions and follow-up questions. Conversation persists per company
 * in sessionStorage. Opens from any `AssistantTrigger`; never docked.
 */
export function CompanyAssistant({ brief }: { brief: CompanyBrief }) {
  const storageKey = `sr-agent:${brief.slug}`;
  const hello: Message = { id: 0, role: 'agent', text: t('companyPage.repHello', { name: brief.name }) };
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([hello]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [animateId, setAnimateId] = useState<number | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ files: Attachment[]; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(1);
  const questions = Array.from({ length: 8 }, (_, i) => t(`companyPage.repQuestions.${i}` as 'companyPage.repQuestions.0'));

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
      /* ignore storage */
    }
  }, [storageKey]);

  useEffect(() => {
    try {
      if (messages.length > 1) window.sessionStorage.setItem(storageKey, JSON.stringify(messages));
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore storage */
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

  // Keep the newest message in view: the content grows while the agent «types», so follow any size change.
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

  const confirmHandoff = (atts: Attachment[], vacancy?: string) => {
    const kind = atts[0]?.purpose ?? 'other';
    const label = vacancy ? ` «${vacancy}»` : '';
    const loginHref = `/login?next=${encodeURIComponent(`/app/messages/new?company=${brief.slug}&kind=${kind}`)}`;
    const reply: Message = {
      id: seq.current++,
      role: 'agent',
      text: `${t('companyPage.attachReceived', { count: atts.length, purpose: t(`companyPage.purposeFor.${kind}`), vacancy: label })} ${t('companyPage.attachNext')}`,
      actions: [
        { label: t('companyPage.attachLogin'), href: loginHref, primary: true },
        { label: t('companyPage.requestQuote'), href: brief.quoteHref },
      ],
      followups: [questions[3]!, questions[0]!],
    };
    setAnimateId(reply.id);
    setMessages((m) => [...m, reply]);
    setThinking(false);
  };

  const pickVacancy = (value: string) => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const title = value === '__none__' ? undefined : value;
    setMessages((m) => [...m, { id: seq.current++, role: 'user', text: title ?? t('companyPage.attachNoVacancy') }]);
    setThinking(true);
    window.setTimeout(
      () =>
        confirmHandoff(
          p.files.map((f) => ({ ...f, vacancy: title })),
          title,
        ),
      400,
    );
  };

  const sendWithFiles = () => {
    if (!files.length || !purpose) return;
    const atts: Attachment[] = files.map((f) => ({ name: f.name, size: f.size, purpose }));
    const text = draft.trim();
    setMessages((m) => [...m, { id: seq.current++, role: 'user', text, attachments: atts }]);
    setFiles([]);
    setPurpose(null);
    setDraft('');
    setError(null);
    setThinking(true);
    const needsVacancy = purpose === 'resume' && brief.vacancies.length > 1;
    window.setTimeout(() => {
      if (needsVacancy) {
        pending.current = { files: atts, text };
        const ask: Message = {
          id: seq.current++,
          role: 'agent',
          text: t('companyPage.attachWhichVacancy'),
          pick: [...brief.vacancies.map((v) => ({ label: v.title, value: v.title })), { label: t('companyPage.attachNoVacancy'), value: '__none__' }],
        };
        setAnimateId(ask.id);
        setMessages((m) => [...m, ask]);
        setThinking(false);
      } else {
        confirmHandoff(
          atts.map((f) => (purpose === 'resume' && brief.vacancies[0] ? { ...f, vacancy: brief.vacancies[0].title } : f)),
          purpose === 'resume' ? brief.vacancies[0]?.title : undefined,
        );
      }
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
    pending.current = null;
    inputRef.current?.focus();
  };
  const fresh = messages.length === 1;

  return (
    <Dialog title={t('companyPage.agentTitle', { name: brief.name })} isOpen={open} onOpenChange={setOpen} size="md" className="cp-agent-dialog">
      <div className="cp-chat">
        <div className="cp-chat__status">
          <span className="cp-chat__dot" aria-hidden="true" />
          {t('companyPage.agentStatus')}
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
                                {fmtSize(f.size)} · {t(`companyPage.purpose.${f.purpose}`)}
                                {f.vacancy ? ` · ${f.vacancy}` : ''} · {t('companyPage.attachDraft')}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ) : (
                <AgentBubble key={m.id} message={m} animate={animateId === m.id} onFollow={ask} onClose={() => setOpen(false)} onPick={pickVacancy} />
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
        <form className={files.length ? 'cp-chat__form cp-chat__form--files' : 'cp-chat__form'} onSubmit={submit}>
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
                    {t(`companyPage.purpose.${p}`)}
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
            <button type="submit" className="cp-chat__send" disabled={thinking || (files.length ? !purpose : !draft.trim())} aria-label={files.length ? t('companyPage.attachSend') : t('companyPage.repSend')}>
              <SendHorizonal size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
