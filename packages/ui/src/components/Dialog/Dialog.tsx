import type { ReactNode } from 'react';
import { Dialog as AriaDialog, DialogTrigger, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { X } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Button, IconButton } from '../Button/Button';
import { Spinner } from '../Spinner/Spinner';
import styles from './Dialog.module.css';

export type DialogSize = 'sm' | 'md' | 'lg' | 'sheet';

export type DialogProps = {
  title: string;
  children: ReactNode;
  /** Controlled open state. */
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Footer actions; place the non-destructive action first so it receives initial focus. */
  actions?: ReactNode;
  size?: DialogSize | undefined;
  /** Shows a loading state over the body and blocks closing via backdrop/Escape. */
  isLoading?: boolean | undefined;
  /** When true, Escape and backdrop do not close (destructive confirmations). */
  isKeyboardDismissDisabled?: boolean | undefined;
  description?: ReactNode;
  className?: string | undefined;
};

/**
 * Modal dialog: `role="dialog"` + `aria-modal`, focus trap, Escape, focus return to the trigger (React Aria).
 * Initial focus goes to the first focusable control in the body or footer (never the close button when actions exist).
 */
export function Dialog({ title, children, isOpen, onOpenChange, actions, size = 'md', isLoading = false, isKeyboardDismissDisabled = false, description, className }: DialogProps) {
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable={!isLoading} isKeyboardDismissDisabled={isKeyboardDismissDisabled || isLoading} className={cx(styles.overlay)}>
      <Modal className={cx(styles.modal, styles[size], className)}>
        <AriaDialog className={cx(styles.dialog)} {...(isLoading ? { 'aria-busy': true } : {})}>
          {({ close }) => (
            <>
              <header className={styles.header}>
                <Heading slot="title" className={cx(styles.title)}>
                  {title}
                </Heading>
                <IconButton icon={X} aria-label={t('dialog.close')} onPress={close} isDisabled={isLoading} className={cx(styles.close)} />
              </header>
              {description ? <p className={styles.description}>{description}</p> : null}
              <div className={styles.body}>{children}</div>
              {isLoading ? (
                <div className={styles.loading} role="status">
                  <Spinner size={24} label={t('dialog.loading')} />
                  <span>{t('dialog.loading')}</span>
                </div>
              ) : null}
              {actions ? <footer className={styles.footer}>{actions}</footer> : null}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

export type ConfirmDialogProps = Omit<DialogProps, 'actions' | 'children'> & {
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string | undefined;
  /** Destructive confirmations use the danger variant and require explicit activation (no Enter-by-default on open). */
  isDestructive?: boolean | undefined;
  onConfirm: () => void;
};

/** Confirmation dialog; the cancel (non-destructive) button comes first and receives initial focus. */
export function ConfirmDialog({ confirmLabel, cancelLabel = t('common.cancel'), isDestructive = false, onConfirm, children, ...rest }: ConfirmDialogProps) {
  return (
    <Dialog
      {...rest}
      size={rest.size ?? 'sm'}
      actions={
        <>
          <Button variant="secondary" onPress={() => rest.onOpenChange(false)} autoFocus>
            {cancelLabel}
          </Button>
          <Button variant={isDestructive ? 'danger' : 'primary'} onPress={onConfirm} isLoading={rest.isLoading ?? false}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

export { DialogTrigger };
