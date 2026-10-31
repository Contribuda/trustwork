import { useEffect, useRef, type ReactNode } from 'react';
import { Form as AriaForm, type FormProps as AriaFormProps } from 'react-aria-components';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import styles from './Form.module.css';

export type FormProps = Omit<AriaFormProps, 'className' | 'style'> & {
  children: ReactNode;
  /** Sets `aria-busy` while submitting; fields should be disabled by the caller. */
  isBusy?: boolean | undefined;
  className?: string | undefined;
};

/** Form wrapper: native validation via React Aria, `aria-busy` while submitting, Enter submits from any field. */
export function Form({ children, isBusy = false, className, ...rest }: FormProps) {
  return (
    <AriaForm {...rest} className={cx(styles.form, className)} {...(isBusy ? { 'aria-busy': true } : {})}>
      {children}
    </AriaForm>
  );
}

export type FormAlertTone = 'info' | 'success' | 'warning' | 'error';

export type FormAlertProps = {
  tone?: FormAlertTone | undefined;
  title?: string | undefined;
  children: ReactNode;
  /** Moves focus to the alert when it appears (submit errors). */
  autoFocus?: boolean | undefined;
  /** Links to fields: list of `{ id, label }` for an error summary. */
  errors?: ReadonlyArray<{ id: string; label: string }> | undefined;
  className?: string | undefined;
};

const icons = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: AlertCircle } as const;

/** Form-level message. `error` uses `role="alert"`; others `role="status"`. Focusable so submit errors can receive focus. */
export function FormAlert({ tone = 'info', title, children, autoFocus = false, errors, className }: FormAlertProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div ref={ref} role={tone === 'error' ? 'alert' : 'status'} tabIndex={-1} className={cx(styles.alert, styles[tone], className)}>
      <Icon icon={icons[tone]} size={20} className={styles.alertIcon} />
      <div className={styles.alertBody}>
        {title ? <p className={styles.alertTitle}>{title}</p> : null}
        <div>{children}</div>
        {errors && errors.length ? (
          <ul className={styles.errorList} aria-label={t('form.errorCount', { count: errors.length })}>
            {errors.map((error) => (
              <li key={error.id}>
                <a href={`#${error.id}`} className={styles.errorLink}>
                  {error.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export type FieldsetProps = { legend: string; description?: ReactNode; children: ReactNode; className?: string | undefined };

/** Native fieldset/legend for grouping related fields. */
export function Fieldset({ legend, description, children, className }: FieldsetProps) {
  return (
    <fieldset className={cx(styles.fieldset, className)}>
      <legend className={styles.legend}>{legend}</legend>
      {description ? <p className={styles.fieldsetDescription}>{description}</p> : null}
      <div className={styles.fieldsetBody}>{children}</div>
    </fieldset>
  );
}

export type FormRowProps = { children: ReactNode; columns?: 1 | 2 | undefined; className?: string | undefined };

/** Layout helper: one or two columns on tablet+, always one column on mobile. */
export function FormRow({ children, columns = 1, className }: FormRowProps) {
  return <div className={cx(styles.row, columns === 2 && styles.twoColumns, className)}>{children}</div>;
}

export type FormActionsProps = { children: ReactNode; align?: 'start' | 'end' | 'stretch' | undefined; className?: string | undefined };

/** Action row; `stretch` makes buttons full width (mobile auth forms). */
export function FormActions({ children, align = 'start', className }: FormActionsProps) {
  return <div className={cx(styles.actions, styles[`align${align.charAt(0).toUpperCase()}${align.slice(1)}`], className)}>{children}</div>;
}

export type DividerProps = { text?: string | undefined; className?: string | undefined };

/** Horizontal rule, optionally with centred text such as «или». */
export function Divider({ text, className }: DividerProps) {
  if (!text) return <hr className={cx(styles.hr, className)} />;
  return (
    <div role="separator" aria-label={text} className={cx(styles.dividerText, className)}>
      <span aria-hidden="true">{text}</span>
    </div>
  );
}
