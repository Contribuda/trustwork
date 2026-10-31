import { useId, type ReactNode } from 'react';
import { Button as AriaButton, ToggleButton, ToggleButtonGroup, type Key } from 'react-aria-components';
import { Check, X } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import styles from './TagSelect.module.css';

export type TagOption = { id: string; label: string; description?: string | undefined; isDisabled?: boolean | undefined };

export type TagSelectProps = {
  /** Group label (visible). */
  label: string;
  description?: ReactNode;
  options: readonly TagOption[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** `card` renders large selectable cards (onboarding capabilities); `pill` renders compact chips. */
  appearance?: 'pill' | 'card' | undefined;
  className?: string | undefined;
};

/** Multi-select pills/cards as toggle buttons (`aria-pressed`) inside a labelled group; selected count is announced. */
export function TagSelect({ label, description, options, selected, onChange, appearance = 'pill', className }: TagSelectProps) {
  const id = useId();
  return (
    <div className={cx(styles.root, className)}>
      <p id={`${id}-label`} className={styles.label}>
        {label}
      </p>
      {description ? (
        <p id={`${id}-desc`} className={styles.description}>
          {description}
        </p>
      ) : null}
      <ToggleButtonGroup
        selectionMode="multiple"
        selectedKeys={new Set<Key>(selected)}
        onSelectionChange={(keys) => onChange([...keys].map(String))}
        aria-labelledby={`${id}-label`}
        {...(description ? { 'aria-describedby': `${id}-desc` } : {})}
        className={cx(styles.group, appearance === 'card' && styles.cards)}
      >
        {options.map((option) => (
          <ToggleButton key={option.id} id={option.id} isDisabled={option.isDisabled ?? false} className={cx(styles.tag, appearance === 'card' && styles.card)}>
            {({ isSelected }) => (
              <>
                <span className={styles.check} aria-hidden="true">
                  {isSelected ? <Icon icon={Check} size={16} /> : null}
                </span>
                <span className={styles.text}>
                  <span className={styles.title}>{option.label}</span>
                  {option.description && appearance === 'card' ? <span className={styles.cardDescription}>{option.description}</span> : null}
                </span>
              </>
            )}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <VisuallyHidden as="p">
        <span role="status" aria-live="polite">
          {t('onboardingFlow.selectedCount', { count: selected.length })}
        </span>
      </VisuallyHidden>
    </div>
  );
}

export type RemovableTagProps = { label: string; onRemove: () => void; className?: string | undefined };

/** Removable constraint chip with a labelled remove button («Убрать «…»»). */
export function RemovableTag({ label, onRemove, className }: RemovableTagProps) {
  return (
    <span className={cx(styles.removable, className)}>
      <span>{label}</span>
      <AriaButton aria-label={t('common.removeItem', { label })} onPress={onRemove} className={cx(styles.removeButton)}>
        <Icon icon={X} size={14} />
      </AriaButton>
    </span>
  );
}
