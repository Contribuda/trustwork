'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AssistantMessage } from '@trustwork/ui';
import { t } from '@/app/_lib/i18n';

export type AssistantState = {
  messages: AssistantMessage[];
  unread: number;
  attention: number;
  isOpen: boolean;
  open: () => void;
  /** Collapses the overlay to the launcher; conversation and unread state are kept as they are. */
  minimize: () => void;
  /** Closes the overlay and treats the conversation as read. */
  close: () => void;
  send: (text: string) => void;
  markRead: () => void;
};

const Context = createContext<AssistantState | null>(null);

/**
 * One conversation for the whole workspace: the floating overlay and `/app/assistant` read and write the
 * same state, which lives in the layout's client shell and survives navigation (links route client-side).
 * The demo echoes a fixed Russian reply; no model is called and chat text never grants authority.
 */
export function AssistantProvider({ initialUnread, attention, children }: { initialUnread: number; attention: number; children: ReactNode }) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [unread, setUnread] = useState(initialUnread);
  const [isOpen, setOpen] = useState(false);

  const send = useCallback((text: string) => {
    const id = `${Date.now()}`;
    setMessages((prev) => [...prev, { id: `u-${id}`, role: 'user', text }]);
    window.setTimeout(() => {
      setMessages((prev) => [...prev, { id: `a-${id}`, role: 'assistant', text: t('assistantPage.demoReply') }]);
    }, 300);
  }, []);

  const value = useMemo<AssistantState>(
    () => ({
      messages,
      unread,
      attention,
      isOpen,
      open: () => setOpen(true),
      minimize: () => setOpen(false),
      close: () => {
        setOpen(false);
        setUnread(0);
      },
      send,
      markRead: () => setUnread(0),
    }),
    [messages, unread, attention, isOpen, send],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAssistant(): AssistantState {
  const value = useContext(Context);
  if (!value) throw new Error('useAssistant requires AssistantProvider');
  return value;
}
