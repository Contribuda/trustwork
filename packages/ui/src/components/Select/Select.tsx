import type { ReactNode } from 'react';
import {
  type Key,
  Button,
  ComboBox as AriaComboBox,
  type ComboBoxProps as AriaComboBoxProps,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  type SelectProps as AriaSelectProps,
  SelectValue,
} from 'react-aria-components';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import { FieldDescription, FieldErrorText, FieldLabel, fieldStyles as styles, invalidProps, type FieldTextProps } from '../Field/FieldParts';

export type SelectOption = { id: Key; label: string; description?: string | undefined; isDisabled?: boolean | undefined };

type SharedProps = FieldTextProps & {
  options: readonly SelectOption[];
  placeholder?: string | undefined;
  className?: string | undefined;
};

export type SelectProps = Omit<AriaSelectProps<SelectOption>, 'children' | 'className' | 'style' | 'isInvalid' | 'placeholder'> & SharedProps;

function Option({ option }: { option: SelectOption }) {
  return (
    <ListBoxItem id={option.id} textValue={option.label} isDisabled={option.isDisabled ?? false} className={cx(styles.option)}>
      {({ isSelected }) => (
        <>
          <span>{option.label}</span>
          {isSelected ? <Icon icon={Check} size={16} className={styles.optionCheck} /> : null}
        </>
      )}
    </ListBoxItem>
  );
}

/** Single-select listbox button (WAI-ARIA select pattern via React Aria). Use for short lists; ComboBox for long ones. */
export function Select({ label, isRequired, description, errorMessage, options, placeholder, className, ...rest }: SelectProps) {
  return (
    <AriaSelect {...rest} {...invalidProps(errorMessage)} {...(isRequired ? { isRequired } : {})} {...(placeholder ? { placeholder } : {})} className={cx(styles.field, className)}>
      <FieldLabel label={label} isRequired={isRequired} />
      <div className={styles.control}>
        <Button className={cx(styles.selectButton)}>
          <SelectValue className={cx(styles.selectValue)} />
          <Icon icon={ChevronDown} size={16} className={styles.chevron} />
        </Button>
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldErrorText message={errorMessage} />
      <Popover className={cx(styles.popover)}>
        <ListBox items={options} className={cx(styles.listbox)}>
          {(option) => <Option option={option} />}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

export type ComboBoxProps = Omit<AriaComboBoxProps<SelectOption>, 'children' | 'className' | 'style' | 'isInvalid'> &
  SharedProps & {
    /** Text shown when filtering yields nothing. */
    emptyText?: ReactNode;
    isLoading?: boolean | undefined;
  };

/** Typeahead combobox (WAI-ARIA combobox pattern): typed filtering, listbox options, announced empty state. */
export function ComboBox({ label, isRequired, description, errorMessage, options, placeholder, className, emptyText, isLoading, ...rest }: ComboBoxProps) {
  return (
    <AriaComboBox {...rest} defaultItems={options} {...invalidProps(errorMessage)} {...(isRequired ? { isRequired } : {})} className={cx(styles.field, className)}>
      <FieldLabel label={label} isRequired={isRequired} />
      <div className={styles.control}>
        <Input className={cx(styles.input)} {...(placeholder ? { placeholder } : {})} />
        <Button className={cx(styles.selectButton, styles.trailing)} style={{ flex: 'none', minHeight: 'var(--size-control-sm)', padding: '0 var(--space-2)' }}>
          <Icon icon={ChevronDown} size={16} className={styles.chevron} />
        </Button>
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldErrorText message={errorMessage} />
      <Popover className={cx(styles.popover)}>
        <ListBox className={cx(styles.listbox)} renderEmptyState={() => <div className={styles.empty}>{isLoading ? t('common.loading') : (emptyText ?? t('common.noResults'))}</div>}>
          {(option: SelectOption) => <Option option={option} />}
        </ListBox>
      </Popover>
    </AriaComboBox>
  );
}
