'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Dialog } from '@trustwork/ui';
import { ArrowRight, ArrowUpRight, Check, Copy, FileText, Paperclip, RotateCcw, SendHorizonal, Sparkles, X } from 'lucide-react';
import { t } from '@/app/_lib/i18n';

/** Serialisable public summary of a person; the only knowledge the agent may use. */
export type PersonBrief = {
  name: string;
  slug: string;
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

type Item = { label: string; meta?: string | undefined; href?: string | null | undefined };
type Action = { label: string; href: string; primary?: boolean };
type Purpose = 'projectOffer' | 'jobOffer' | 'request' | 'other';
type Attachment = { name: string; size: number; purpose: Purpose };
type Message = { id: number; role: 'user' | 'agent'; text: string; items?: Item[]; chips?: string[]; sources?: Array<{ id: string; label: string }>; actions?: Action[]; followups?: string[]; attachments?: Attachment[] };
type Topic = 'about' | 'services' | 'portfolio' | 'status' | 'experience' | 'contacts' | 'projects' | 'publications' | 'documents';

const PURPOSES: Purpose[] = ['projectOffer', 'jobOffer', 'request', 'other'];
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,application/pdf,image/*';
const MAX_SIZE = 10 * 1024 * 1024;
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
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

function answer(brief: PersonBrief, q: string, id: number): Message {
  const questions = Array.from({ length: 8 }, (_, i) => t(`personPage.agentQuestions.${i}` as 'personPage.agentQuestions.0'));
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

const OPEN_EVENT = 'person-agent:open';

export function PersonAgentTrigger({ question, className, children }: { question?: string | undefined; className?: string | undefined; children: React.ReactNode }) {
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
      await navigator.clipboard.writeText([message.text, ...(message.chips ?? []).map((c) => `• ${c}`), ...(message.items ?? []).map((i) => `• ${i.label}${i.meta ? ` — ${i.meta}` : ''}`)].join('\n'));
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

/** Person's agent (demo): answers from the public brief, accepts attachments (project or job offers, requests) handed over after sign-in. */
export function PersonAssistant({ brief }: { brief: PersonBrief }) {
  const storageKey = `sr-person-agent:${brief.slug}`;
  const hello: Message = { id: 0, role: 'agent', text: t('personPage.agentHello', { name: brief.name }) };
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
  const questions = Array.from({ length: 8 }, (_, i) => t(`personPage.agentQuestions.${i}` as 'personPage.agentQuestions.0'));

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
        text: `${t('personPage.attachReceived', { count: atts.length, purpose: t(`personPage.purposeFor.${purpose}`), name: brief.name })} ${t('personPage.attachNext')}`,
        actions: [{ label: t('personPage.attachLogin'), href: `${brief.messageHref}&kind=${purpose}`, primary: true }],
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
    <Dialog title={t('personPage.agentTitle', { name: brief.name })} isOpen={open} onOpenChange={setOpen} size="md" className="cp-agent-dialog">
      <div className="cp-chat">
        <div className="cp-chat__status">
          <span className="cp-chat__dot" aria-hidden="true" />
          {t('personPage.agentStatus')}
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
                                {fmtSize(f.size)} · {t(`personPage.purpose.${f.purpose}`)} · {t('companyPage.attachDraft')}
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
                    {t(`personPage.purpose.${p}`)}
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
