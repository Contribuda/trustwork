import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Button, IconButton } from '../Button/Button';
import { Icon } from '../Icon/Icon';
import styles from './Toast.module.css';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export type ToastInput = {
  tone?: ToastTone | undefined;
  title: string;
  description?: string | undefined;
  /** Optional action rendered as a secondary button. */
  action?: { label: string; onPress: () => void } | undefined;
  /** Milliseconds before auto-dismiss (≥ 5000); errors never auto-dismiss. */
  timeout?: number | undefined;
};

export type ToastRecord = ToastInput & { id: number };

type ToastContextValue = {
  toasts: readonly ToastRecord[];
  add: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

/** Provides the toast queue; render `ToastRegion` once near the end of the document body. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((item) => item.id !== id)), []);
  const add = useCallback((toast: ToastInput) => {
    const id = ++counter.current;
    setToasts((list) => [...list, { ...toast, id }]);
    return id;
  }, []);
  const value = useMemo(() => ({ toasts, add, dismiss }), [toasts, add, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}

const icons = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: AlertCircle } as const;

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: () => void }) {
  const tone = toast.tone ?? 'info';
  const [paused, setPaused] = useState(false);
  const timeout = tone === 'error' ? null : Math.max(5000, toast.timeout ?? 6000);
  useEffect(() => {
    if (timeout === null || paused) return;
    const handle = window.setTimeout(onDismiss, timeout);
    return () => window.clearTimeout(handle);
  }, [timeout, paused, onDismiss]);
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(styles.toast, styles[tone])}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon icon={icons[tone]} size={20} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.title}>{toast.title}</p>
        {toast.description ? <p className={styles.description}>{toast.description}</p> : null}
        {toast.action ? (
          <Button size="sm" variant="secondary" onPress={toast.action.onPress} className={cx(styles.action)}>
            {toast.action.label}
          </Button>
        ) : null}
      </div>
      <IconButton size="sm" icon={X} aria-label={t('toast.dismiss')} onPress={onDismiss} />
    </div>
  );
}

/** `aria-live="polite"` region labelled «Уведомления о действиях»; toasts persist ≥ 5 s and pause on hover/focus. */
export function ToastRegion({ className }: { className?: string | undefined }) {
  const { toasts, dismiss } = useToast();
  return (
    <section aria-label={t('toast.regionLabel')} aria-live="polite" className={cx(styles.region, className)}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </section>
  );
}
