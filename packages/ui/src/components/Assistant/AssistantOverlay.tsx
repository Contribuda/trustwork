import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Dialog as AriaDialog, Modal, ModalOverlay, TextArea as AriaTextArea, TextField as AriaTextField, Label } from 'react-aria-components';
import { ExternalLink, Minus, Paperclip, SendHorizontal, WifiOff, X } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { Button, IconButton, IconLink } from '../Button/Button';
import { Icon } from '../Icon/Icon';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import styles from './Assistant.module.css';

export type AssistantMessage = { id: string; role: 'user' | 'assistant'; text: ReactNode; at?: string | undefined; isUnread?: boolean | undefined; notSent?: boolean | undefined };

export type AssistantOverlayProps = {
  isOpen: boolean;
  onClose: () => void;
  onMinimize?: (() => void) | undefined;
  /** Link to the full page `/app/assistant`. */
  pageHref: string;
  state?: 'online' | 'offline' | 'unavailable' | undefined;
  messages: readonly AssistantMessage[];
  onSend?: ((text: string) => void) | undefined;
  onAttach?: (() => void) | undefined;
  unreadCount?: number | undefined;
  /** Approvals waiting; renders the attention strip. */
  attentionCount?: number | undefined;
  onAttentionOpen?: (() => void) | undefined;
  /** Element that receives focus when the overlay closes (the launcher). */
  returnFocusTo?: RefObject<HTMLElement | null> | undefined;
  /** `auto` = sheet below 768 px, panel otherwise. */
  mode?: 'auto' | 'panel' | 'sheet' | undefined;
  className?: string | undefined;
};

function Conversation({ messages, state }: { messages: readonly AssistantMessage[]; state: NonNullable<AssistantOverlayProps['state']> }) {
  return (
    <div role="log" aria-live="polite" aria-label={t('assistant.overlay.conversation')} className={styles.log}>
      {messages.length === 0 ? <p className={styles.intro}>{t('assistant.intro')}</p> : null}
      {messages.map((message) => (
        <div key={message.id} className={cx(styles.message, styles[message.role], message.isUnread && styles.unread)}>
          <VisuallyHidden>{message.role === 'user' ? t('assistant.messageFromUser') : t('assistant.messageFromAssistant')}: </VisuallyHidden>
          <div className={styles.bubble}>{message.text}</div>
          {message.notSent ? <span className={styles.notSent}>{t('assistant.notSent')}</span> : null}
        </div>
      ))}
      {state === 'unavailable' ? (
        <div role="status" className={cx(styles.message, styles.assistant)}>
          <div className={cx(styles.bubble, styles.statusCard)}>{t('assistant.overlay.stateUnavailable')}</div>
        </div>
      ) : null}
    </div>
  );
}

function Composer({ onSend, onAttach, disabled }: { onSend: ((text: string) => void) | undefined; onAttach: (() => void) | undefined; disabled: boolean }) {
  const [value, setValue] = useState('');
  const hintId = useId();
  const send = () => {
    const text = value.trim();
    if (!text || !onSend) return;
    onSend(text);
    setValue('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };
  return (
    <div className={styles.composer}>
      <AriaTextField value={value} onChange={setValue} isDisabled={disabled} className={cx(styles.composerField)}>
        <Label className={cx(styles.visuallyHidden)}>{t('assistant.composer.label')}</Label>
        <AriaTextArea rows={2} placeholder={t('assistant.composer.placeholder')} onKeyDown={onKeyDown} className={cx(styles.composerInput)} aria-describedby={hintId} />
      </AriaTextField>
      <div className={styles.composerActions}>
        {onAttach ? <IconButton icon={Paperclip} aria-label={t('assistant.composer.attach')} onPress={onAttach} isDisabled={disabled} /> : null}
        <IconButton icon={SendHorizontal} variant="accent" aria-label={t('assistant.composer.send')} onPress={send} isDisabled={disabled} />
      </div>
      <p id={hintId} className={styles.hint}>
        {disabled ? t('assistant.overlay.stateOffline') : t('assistant.composer.hint')}
      </p>
    </div>
  );
}

function OverlayBody({
  onClose,
  onMinimize,
  pageHref,
  state,
  messages,
  onSend,
  onAttach,
  unreadCount,
  attentionCount,
  onAttentionOpen,
  closeRef,
  isSheet,
}: Required<Pick<AssistantOverlayProps, 'onClose' | 'pageHref' | 'messages'>> & {
  onMinimize: AssistantOverlayProps['onMinimize'];
  state: NonNullable<AssistantOverlayProps['state']>;
  onSend: AssistantOverlayProps['onSend'];
  onAttach: AssistantOverlayProps['onAttach'];
  unreadCount: number;
  attentionCount: number;
  onAttentionOpen: AssistantOverlayProps['onAttentionOpen'];
  closeRef: RefObject<HTMLButtonElement | null>;
  isSheet: boolean;
}) {
  return (
    <>
      <header className={styles.overlayHeader}>
        <div className={styles.overlayTitleGroup}>
          <h2 className={styles.overlayTitle}>{t('assistant.title')}</h2>
          <p className={styles.stateLine} role="status">
            {state === 'offline' ? (
              <>
                <Icon icon={WifiOff} size={14} /> {t('assistant.overlay.stateOffline')}
              </>
            ) : (
              t('assistant.overlay.stateOnline')
            )}
            {unreadCount > 0 ? <VisuallyHidden>. {t('assistant.overlay.newMessages', { count: unreadCount })}</VisuallyHidden> : null}
          </p>
        </div>
        <div className={styles.overlayActions}>
          <IconLink icon={ExternalLink} aria-label={t('assistant.overlay.openPage')} href={pageHref} />
          {onMinimize && !isSheet ? <IconButton icon={Minus} aria-label={t('assistant.overlay.minimize')} onPress={onMinimize} /> : null}
          <IconButton ref={closeRef} icon={X} aria-label={t('assistant.overlay.close')} onPress={onClose} />
        </div>
      </header>
      {attentionCount > 0 ? (
        <div className={styles.attention} role="status">
          <span>{t('assistant.attention', { count: attentionCount })}</span>
          {onAttentionOpen ? (
            <Button size="sm" variant="secondary" onPress={onAttentionOpen}>
              {t('assistant.attentionOpen')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Conversation messages={messages} state={state} />
      <Composer onSend={onSend} onAttach={onAttach} disabled={state === 'offline'} />
    </>
  );
}

/**
 * The single assistant overlay. Desktop/tablet: `position: fixed` 400×640 non-modal `role="complementary"`
 * panel bottom-right above the launcher, Tab leaves it in DOM order, Escape inside closes and returns focus to the
 * launcher. Mobile: full-screen modal sheet with focus trap. The page is never pushed or resized.
 */
export function AssistantOverlay({
  isOpen,
  onClose,
  onMinimize,
  pageHref,
  state = 'online',
  messages,
  onSend,
  onAttach,
  unreadCount = 0,
  attentionCount = 0,
  onAttentionOpen,
  returnFocusTo,
  mode = 'auto',
  className,
}: AssistantOverlayProps) {
  const isMobile = useIsMobile();
  const isSheet = mode === 'sheet' || (mode === 'auto' && isMobile);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (isOpen && !isSheet) closeRef.current?.focus();
    if (!isOpen && wasOpen.current) returnFocusTo?.current?.focus();
    wasOpen.current = isOpen;
  }, [isOpen, isSheet, returnFocusTo]);

  const body = (
    <OverlayBody
      onClose={onClose}
      onMinimize={onMinimize}
      pageHref={pageHref}
      state={state}
      messages={messages}
      onSend={onSend}
      onAttach={onAttach}
      unreadCount={unreadCount}
      attentionCount={attentionCount}
      onAttentionOpen={onAttentionOpen}
      closeRef={closeRef}
      isSheet={isSheet}
    />
  );

  if (isSheet) {
    return (
      <ModalOverlay isOpen={isOpen} onOpenChange={(open) => (!open ? onClose() : undefined)} isDismissable className={cx(styles.sheetOverlay)}>
        <Modal className={cx(styles.sheet)}>
          <AriaDialog aria-label={t('assistant.overlay.label')} className={cx(styles.panelInner, className)}>
            {body}
          </AriaDialog>
        </Modal>
      </ModalOverlay>
    );
  }

  if (!isOpen) return null;
  return (
    <aside
      role="complementary"
      aria-label={t('assistant.overlay.label')}
      className={cx(styles.panel, className)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={styles.panelInner}>{body}</div>
    </aside>
  );
}
