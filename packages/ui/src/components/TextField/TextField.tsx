import { useState, type ReactNode } from 'react';
import { Input, TextArea as AriaTextArea, TextField as AriaTextField, type TextFieldProps as AriaTextFieldProps } from 'react-aria-components';
import type { LucideIcon } from 'lucide-react';
import { Eye, EyeOff } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import { IconButton } from '../Button/Button';
import { FieldDescription, FieldErrorText, FieldLabel, fieldStyles as styles, invalidProps, type FieldTextProps } from '../Field/FieldParts';

type SharedProps = Omit<AriaTextFieldProps, 'children' | 'className' | 'style' | 'isInvalid'> &
  FieldTextProps & {
    placeholder?: string | undefined;
    className?: string | undefined;
    /** Decorative leading icon (the label names the field). */
    icon?: LucideIcon | undefined;
    trailing?: ReactNode;
  };

export type TextFieldProps = SharedProps & {
  /** Browser autofill hint, e.g. `email`, `username`, `current-password`. Never `off` for auth fields. */
  autoComplete?: string | undefined;
  inputMode?: 'text' | 'email' | 'tel' | 'url' | 'numeric' | 'decimal' | 'search' | undefined;
};

/** Single-line input with label, description and inline error (`aria-invalid` + `aria-describedby`). Paste is always allowed. */
export function TextField({ label, isRequired, description, errorMessage, placeholder, className, icon, trailing, autoComplete, inputMode, ...rest }: TextFieldProps) {
  return (
    <AriaTextField {...rest} {...invalidProps(errorMessage)} {...(isRequired ? { isRequired } : {})} className={cx(styles.field, className)}>
      <FieldLabel label={label} isRequired={isRequired} />
      <div className={styles.control}>
        {icon ? <Icon icon={icon} className={styles.leadingIcon} /> : null}
        <Input className={cx(styles.input)} {...(placeholder ? { placeholder } : {})} {...(autoComplete ? { autoComplete } : {})} {...(inputMode ? { inputMode } : {})} />
        {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldErrorText message={errorMessage} />
    </AriaTextField>
  );
}

export type TextAreaProps = Omit<SharedProps, 'icon' | 'trailing'> & {
  rows?: number | undefined;
  maxLength?: number | undefined;
  /** Show «Осталось N символов» counter (requires `maxLength`). */
  showCounter?: boolean | undefined;
};

/** Multi-line input; counter is announced politely and never blocks typing. */
export function TextArea({ label, isRequired, description, errorMessage, placeholder, className, rows = 4, maxLength, showCounter, ...rest }: TextAreaProps) {
  const [length, setLength] = useState((rest.value ?? rest.defaultValue ?? '').length);
  return (
    <AriaTextField
      {...rest}
      {...invalidProps(errorMessage)}
      {...(isRequired ? { isRequired } : {})}
      className={cx(styles.field, className)}
      onChange={(value) => {
        setLength(value.length);
        rest.onChange?.(value);
      }}
    >
      <FieldLabel label={label} isRequired={isRequired} />
      <div className={styles.control}>
        <AriaTextArea className={cx(styles.input, styles.textarea)} rows={rows} {...(placeholder ? { placeholder } : {})} {...(maxLength ? { maxLength } : {})} />
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {showCounter && maxLength ? (
        <div className={styles.counter} aria-live="polite">
          {t('common.charactersLeft', { count: Math.max(0, maxLength - length) })}
        </div>
      ) : null}
      <FieldErrorText message={errorMessage} />
    </AriaTextField>
  );
}

export type PasswordFieldProps = Omit<TextFieldProps, 'type' | 'trailing' | 'inputMode'> & {
  autoComplete?: 'current-password' | 'new-password' | undefined;
};

/** Password input with a show/hide toggle (`aria-pressed`), password managers and paste allowed. */
export function PasswordField({ label, isRequired, description, errorMessage, placeholder, className, icon, autoComplete = 'current-password', ...rest }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <AriaTextField {...rest} type={visible ? 'text' : 'password'} {...invalidProps(errorMessage)} {...(isRequired ? { isRequired } : {})} className={cx(styles.field, className)}>
      <FieldLabel label={label} isRequired={isRequired} />
      <div className={styles.control}>
        {icon ? <Icon icon={icon} className={styles.leadingIcon} /> : null}
        <Input className={cx(styles.input)} autoComplete={autoComplete} {...(placeholder ? { placeholder } : {})} />
        <div className={styles.trailing}>
          <IconButton
            size="sm"
            icon={visible ? EyeOff : Eye}
            aria-label={visible ? t('auth.hidePassword') : t('auth.showPassword')}
            isPressed={visible}
            onPress={() => setVisible((v) => !v)}
            excludeFromTabOrder={false}
          />
        </div>
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldErrorText message={errorMessage} />
    </AriaTextField>
  );
}
