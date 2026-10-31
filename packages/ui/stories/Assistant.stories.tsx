import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { AssistantLauncher } from '../src/components/Assistant/AssistantLauncher';
import { AssistantOverlay, type AssistantMessage } from '../src/components/Assistant/AssistantOverlay';
import { CitationChip } from '../src/components/Citation/Citation';

const messages: AssistantMessage[] = [
  { id: '1', role: 'user', text: 'Какие предложения по фасадным панелям готовы к сравнению?', at: '2026-10-27T09:00:00Z' },
  {
    id: '2',
    role: 'assistant',
    text: (
      <>
        Готовы два предложения <CitationChip index={1} /> и <CitationChip index={2} />. Третье устарело: ответ на версию 1 <CitationChip index={3} state={{ kind: 'historical', date: '2026-09-12' }} />.
      </>
    ),
    isUnread: true,
  },
];

function Demo({
  initialOpen = true,
  unread = 0,
  attention = 0,
  state = 'online',
  mode = 'auto',
  withMessages = true,
}: {
  initialOpen?: boolean;
  unread?: number;
  attention?: number;
  state?: 'online' | 'offline' | 'unavailable';
  mode?: 'auto' | 'panel' | 'sheet';
  withMessages?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const [list, setList] = useState<AssistantMessage[]>(withMessages ? messages : []);
  return (
    <div style={{ minHeight: 720 }}>
      <main id="main" data-testid="page-content" style={{ maxWidth: 960, padding: 24 }}>
        <h1>Обзор</h1>
        <p>Страница остаётся на месте: окно помощника всплывает поверх содержимого и не сдвигает его.</p>
        <button type="button">Кнопка на странице</button>
      </main>
      <AssistantOverlay
        isOpen={open}
        onClose={() => setOpen(false)}
        onMinimize={() => setOpen(false)}
        pageHref="/app/assistant"
        state={state}
        messages={list}
        onSend={(text) => setList((l) => [...l, { id: String(l.length + 1), role: 'user', text, notSent: state === 'unavailable' }])}
        onAttach={() => undefined}
        unreadCount={unread}
        attentionCount={attention}
        onAttentionOpen={() => undefined}
        returnFocusTo={launcherRef}
        mode={mode}
      />
      <AssistantLauncher ref={launcherRef} isOpen={open} onPress={() => setOpen((v) => !v)} unreadCount={unread} actionRequired={attention > 0} isHidden={open && mode === 'sheet'} />
    </div>
  );
}

const meta = { title: 'Shell/Assistant launcher and overlay', component: AssistantOverlay, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof AssistantOverlay>;
export default meta;
type Story = StoryObj;

export const LauncherClosed: Story = { render: () => <Demo initialOpen={false} /> };
export const LauncherUnread: Story = { render: () => <Demo initialOpen={false} unread={2} /> };
export const LauncherActionRequired: Story = { render: () => <Demo initialOpen={false} attention={1} /> };
export const OverlayOpen: Story = { render: () => <Demo mode="panel" /> };
export const OverlayEmpty: Story = { render: () => <Demo mode="panel" withMessages={false} /> };
export const OverlayUnreadAndAttention: Story = { render: () => <Demo mode="panel" unread={1} attention={2} /> };
export const OverlayOffline: Story = { render: () => <Demo mode="panel" state="offline" /> };
export const OverlayUnavailable: Story = { render: () => <Demo mode="panel" state="unavailable" /> };
export const MobileSheet: Story = { render: () => <Demo mode="sheet" />, globals: { viewport: { value: 'mobile375', isRotated: false } } };
