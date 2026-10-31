import type { ReactNode } from 'react';
import { FieldError, Label, Text } from 'react-aria-components';
import { AlertCircle } from 'lucide-react';
import { t } from '../../i18n';
import { cx } from '../../utils/cx';
import { Icon } from '../Icon/Icon';
import styles from './field.module.css';

export type FieldTextProps = {
  label: string;
  /** Required marker rendered as text («обязательно»), never only an asterisk. */
  isRequired?: boolean | undefined;
  description?: ReactNode;
  /** Error text; when present the field is invalid and the message is linked via `aria-describedby` by React Aria. */
  errorMessage?: string | undefined;
};

export function FieldLabel({ label, isRequired }: Pick<FieldTextProps, 'label' | 'isRequired'>) {
  return (
    <Label className={cx(styles.label)}>
      {label}
      {isRequired ? <span className={styles.requiredMark}>({t('common.required')})</span> : null}
    </Label>
  );
}

export function FieldDescription({ children }: { children: ReactNode }) {
  return (
    <Text slot="description" className={cx(styles.description)}>
      {children}
    </Text>
  );
}

/** React Aria `FieldError` renders only when invalid and links itself with `aria-describedby`. */
export function FieldErrorText({ message }: { message?: string | undefined }) {
  return (
    <FieldError className={cx(styles.error)}>
      {({ validationErrors }) => (
        <>
          <Icon icon={AlertCircle} size={16} />
          <span>{message ?? validationErrors.join(' ')}</span>
        </>
      )}
    </FieldError>
  );
}

export const fieldStyles = styles;

/** Spread helper: marks the field invalid only when an error message exists (keeps exactOptionalPropertyTypes happy). */
export function invalidProps(errorMessage: string | undefined): { isInvalid?: true } {
  return errorMessage ? { isInvalid: true } : {};
}
