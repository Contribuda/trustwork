import type { ReactNode } from 'react';
import {
  Checkbox as AriaCheckbox,
  CheckboxGroup as AriaCheckboxGroup,
  type CheckboxGroupProps as AriaCheckboxGroupProps,
  type CheckboxProps as AriaCheckboxProps,
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  type RadioGroupProps as AriaRadioGroupProps,
  type RadioProps as AriaRadioProps,
  Switch as AriaSwitch,
  type SwitchProps as AriaSwitchProps,
  Label,
  Text,
} from 'react-aria-components';
import { Check, Minus } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import { FieldErrorText, fieldStyles, invalidProps } from '../Field/FieldParts';
import styles from './Choice.module.css';

export type CheckboxProps = Omit<AriaCheckboxProps, 'children' | 'className' | 'style'> & {
  children: ReactNode;
  description?: ReactNode;
  className?: string | undefined;
};

/** Checkbox with the label inside the control's label element; supports indeterminate (`mixed`). */
export function Checkbox({ children, description, className, ...rest }: CheckboxProps) {
  return (
    <AriaCheckbox {...rest} className={cx(styles.choice, className)}>
      {({ isSelected, isIndeterminate }) => (
        <>
          <span className={cx(styles.box, styles.checkbox)} aria-hidden="true">
            {isIndeterminate ? <Icon icon={Minus} size={16} /> : isSelected ? <Icon icon={Check} size={16} /> : null}
          </span>
          <span className={styles.text}>
            <span>{children}</span>
            {description ? <span className={styles.description}>{description}</span> : null}
          </span>
        </>
      )}
    </AriaCheckbox>
  );
}

type GroupTextProps = { label: string; description?: ReactNode; errorMessage?: string | undefined; className?: string | undefined; orientation?: 'vertical' | 'horizontal' | undefined };

export type CheckboxGroupProps = Omit<AriaCheckboxGroupProps, 'children' | 'className' | 'style' | 'isInvalid'> & GroupTextProps & { children: ReactNode };

/** Group with its own label (`role="group"` + `aria-labelledby`), description and error. */
export function CheckboxGroup({ label, description, errorMessage, className, orientation = 'vertical', children, ...rest }: CheckboxGroupProps) {
  return (
    <AriaCheckboxGroup {...rest} {...invalidProps(errorMessage)} className={cx(fieldStyles.field, className)}>
      <Label className={cx(fieldStyles.label)}>{label}</Label>
      {description ? (
        <Text slot="description" className={cx(fieldStyles.description)}>
          {description}
        </Text>
      ) : null}
      <div className={cx(styles.group, orientation === 'horizontal' && styles.horizontal)}>{children}</div>
      <FieldErrorText message={errorMessage} />
    </AriaCheckboxGroup>
  );
}

export type RadioGroupProps = Omit<AriaRadioGroupProps, 'children' | 'className' | 'style' | 'isInvalid'> & GroupTextProps & { children: ReactNode };

/** Radio group (`role="radiogroup"`, arrow keys move selection). */
export function RadioGroup({ label, description, errorMessage, className, orientation = 'vertical', children, ...rest }: RadioGroupProps) {
  return (
    <AriaRadioGroup {...rest} orientation={orientation} {...invalidProps(errorMessage)} className={cx(fieldStyles.field, className)}>
      <Label className={cx(fieldStyles.label)}>{label}</Label>
      {description ? (
        <Text slot="description" className={cx(fieldStyles.description)}>
          {description}
        </Text>
      ) : null}
      <div className={cx(styles.group, orientation === 'horizontal' && styles.horizontal)}>{children}</div>
      <FieldErrorText message={errorMessage} />
    </AriaRadioGroup>
  );
}

export type RadioProps = Omit<AriaRadioProps, 'children' | 'className' | 'style'> & { children: ReactNode; description?: ReactNode; className?: string | undefined };

export function Radio({ children, description, className, ...rest }: RadioProps) {
  return (
    <AriaRadio {...rest} className={cx(styles.choice, className)}>
      <span className={cx(styles.box, styles.radio)} aria-hidden="true">
        <span className={styles.radioDot} />
      </span>
      <span className={styles.text}>
        <span>{children}</span>
        {description ? <span className={styles.description}>{description}</span> : null}
      </span>
    </AriaRadio>
  );
}

export type SwitchProps = Omit<AriaSwitchProps, 'children' | 'className' | 'style'> & {
  children: ReactNode;
  /** Visible on/off words so state is never colour-only (defaults «Вкл.»/«Выкл.»). */
  onText?: string | undefined;
  offText?: string | undefined;
  isLoading?: boolean | undefined;
  className?: string | undefined;
};

/** `role="switch"` with `aria-checked`; the label describes the effect, the on/off text shows state. */
export function Switch({ children, onText = t('common.on'), offText = t('common.off'), isLoading = false, className, ...rest }: SwitchProps) {
  return (
    <AriaSwitch {...rest} isDisabled={rest.isDisabled || isLoading} className={cx(styles.choice, styles.switchRoot, className)} {...(isLoading ? { 'aria-busy': true } : {})}>
      {({ isSelected }) => (
        <>
          <span className={styles.text}>{children}</span>
          <span className={styles.switchState}>{isSelected ? onText : offText}</span>
          <span className={styles.track} aria-hidden="true">
            <span className={styles.thumb} />
          </span>
        </>
      )}
    </AriaSwitch>
  );
}
