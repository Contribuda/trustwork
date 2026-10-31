'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Dialog } from '@trustwork/ui';
import { ArrowRight, ArrowUpRight, Check, Copy, FileText, Paperclip, RotateCcw, SendHorizonal, Sparkles, X } from 'lucide-react';
import { intlTag } from '@trustwork/ui/i18n';
import { t } from '@/app/_lib/i18n';
import { openEventOf, type AgentAttachment, type AgentKind, type AgentMessage, type AgentProfile, type BaseBrief } from './types';
import { localHref } from '@/app/_lib/localize';

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,application/pdf,image/*';
const MAX_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 3;
const fmtSize = (n: number) =>
  n >= 1024 * 1024
    ? new Intl.NumberFormat(intlTag(), { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(n / 1024 / 1024)
    : new Intl.NumberFormat(intlTag(), { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 }).format(Math.max(1, n / 1024));

/** Button that opens the agent dialog of `kind` (optionally with a prefilled question); usable from server markup. */
export function AgentTrigger({ kind, question, className, children }: { kind: AgentKind; question?: string | undefined; className?: string | undefined; children: ReactNode }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new CustomEvent(openEventOf(kind), { detail: { question } }))}>
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

function AgentBubble({ message, animate, onFollow, onClose, onPick }: { message: AgentMessage; animate: boolean; onFollow: (q: string) => void; onClose: () => void; onPick: (value: string) => void }) {
  const text = useTypewriter(message.text, animate);
  const done = text === message.text;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([message.text, ...(message.chips ?? []).map((c) => `• ${c}`), ...(message.items ?? []).map((i) => `• ${i.label}${i.meta ? ` — ${i.meta}` : ''}`)].join('\n'));
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
                <a key={a.href + a.label} href={localHref(a.href)} className={a.primary ? 'cp-msg__action cp-msg__action--primary' : 'cp-msg__action'}>
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
 * Public entity agent (demo) for a company, person or project page: one dialog parameterized by an
 * `AgentProfile`. It answers from the public brief only (structured lists with links, the section each answer
 * comes from, quick actions and follow-up questions), accepts up to three attachments with a purpose that are
 * handed over after sign-in, and keeps the conversation per entity in sessionStorage. Opens from any
 * `AgentTrigger` of the same kind; never docked.
 */
export function PublicAssistant<B extends BaseBrief, P extends string>({ profile, brief }: { profile: AgentProfile<B, P>; brief: B }) {
  type Message = AgentMessage<P>;
  const storageKey = `${profile.storagePrefix}${brief.handle}`;
  const hello: Message = { id: 0, role: 'agent', text: profile.hello(brief) };
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([hello]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [animateId, setAnimateId] = useState<number | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [purpose, setPurpose] = useState<P | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AgentAttachment<P>[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(1);
  const nextId = () => seq.current++;
  const questions = profile.questions();

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
    setMessages((m) => [...m, { id: nextId(), role: 'user', text }]);
    setDraft('');
    setThinking(true);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(
      () => {
        const reply = profile.answer(brief, text, nextId());
        setAnimateId(reduce ? null : reply.id);
        setMessages((m) => [...m, reply]);
        setThinking(false);
      },
      reduce ? 0 : 500,
    );
  };

  useEffect(() => {
    const event = openEventOf(profile.kind);
    const onOpen = (e: Event) => {
      setOpen(true);
      const q = (e as CustomEvent<{ question?: string }>).detail?.question;
      if (q) window.setTimeout(() => ask(q), 80);
    };
    window.addEventListener(event, onOpen);
    return () => window.removeEventListener(event, onOpen);
  }, [brief, profile]);

  // Keep the newest message in view: the content grows while the agent types, so follow any size change.
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
      if (next.length >= MAX_FILES) {
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

  const pick = (value: string) => {
    const waiting = pending.current;
    if (!waiting || !profile.pick) return;
    pending.current = null;
    const step = profile.pick(brief, waiting, value, nextId, questions);
    setMessages((m) => [...m, { id: nextId(), role: 'user', text: step.label }]);
    setThinking(true);
    window.setTimeout(() => {
      const reply = step.reply();
      setAnimateId(reply.id);
      setMessages((m) => [...m, reply]);
      setThinking(false);
    }, 400);
  };

  const sendWithFiles = () => {
    if (!files.length || !purpose) return;
    const chosen = purpose;
    const atts: AgentAttachment<P>[] = files.map((f) => ({ name: f.name, size: f.size, purpose: chosen }));
    setMessages((m) => [...m, { id: nextId(), role: 'user', text: draft.trim(), attachments: atts }]);
    setFiles([]);
    setPurpose(null);
    setDraft('');
    setError(null);
    setThinking(true);
    window.setTimeout(() => {
      const step = profile.handoff(brief, atts, chosen, nextId, questions);
      if (step.pending) pending.current = step.pending;
      setAnimateId(step.reply.id);
      setMessages((m) => [...m, step.reply]);
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
    pending.current = null;
    inputRef.current?.focus();
  };
  const fresh = messages.length === 1;

  return (
    <Dialog title={profile.title(brief)} isOpen={open} onOpenChange={setOpen} size="md" className="cp-agent-dialog">
      <div className="cp-chat">
        <div className="cp-chat__status">
          <span className="cp-chat__dot" aria-hidden="true" />
          {profile.status()}
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
                                {fmtSize(f.size)} · {profile.purposeLabel(f.purpose)}
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
                <AgentBubble key={m.id} message={m} animate={animateId === m.id} onFollow={ask} onClose={() => setOpen(false)} onPick={pick} />
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
                {profile.purposes.map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={purpose === p} className={purpose === p ? 'cp-chip cp-chip--on' : 'cp-chip'} onClick={() => setPurpose(p)}>
                    {profile.purposeLabel(p)}
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
