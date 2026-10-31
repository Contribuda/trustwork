import { Check, ChevronDown, FlaskConical } from 'lucide-react';
import { Button as AriaButton, Menu as AriaMenu, MenuItem, MenuTrigger, Popover as AriaPopover } from 'react-aria-components';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import styles from './DemoBanner.module.css';

export type DemoPersona = { id: string; label: string };

export type DemoBannerProps = {
  /** Overrides the default message «Демонстрационные данные …». */
  message?: string | undefined;
  personas: readonly DemoPersona[];
  currentId: string;
  onChange: (id: string) => void;
  className?: string | undefined;
};

/**
 * 32 px muted strip for demo deployments: one line of status text and a compact popover to switch the demo persona.
 * `role="status"` so the message is announced once; the switch is a menu button named by its visible text («Демонстрационный участник: Гость»).
 */
export function DemoBanner({ message = t('demo.banner'), personas, currentId, onChange, className }: DemoBannerProps) {
  const current = personas.find((p) => p.id === currentId) ?? personas[0];
  return (
    <div className={cx(styles.banner, className)} role="status">
      <span className={styles.message}>
        <Icon icon={FlaskConical} size={14} />
        <span className={styles.text}>{message}</span>
      </span>
      <MenuTrigger>
        <AriaButton className={cx(styles.switch)}>
          <span className={styles.switchLabel}>{t('demo.persona')}:</span>
          <span className={styles.switchValue}>{current?.label}</span>
          <Icon icon={ChevronDown} size={14} />
        </AriaButton>
        <AriaPopover placement="bottom end" offset={6} className={cx(styles.popover)}>
          <AriaMenu
            aria-label={t('demo.persona')}
            className={cx(styles.menu)}
            selectionMode="single"
            selectedKeys={[currentId]}
            onSelectionChange={(keys) => {
              if (keys === 'all') return;
              const [first] = [...keys];
              if (first !== undefined) onChange(String(first));
            }}
          >
            {personas.map((persona) => (
              <MenuItem key={persona.id} id={persona.id} className={cx(styles.item)}>
                {({ isSelected }) => (
                  <>
                    <span className={styles.itemLabel}>{persona.label}</span>
                    {isSelected ? <Icon icon={Check} size={16} className={styles.check} /> : null}
                  </>
                )}
              </MenuItem>
            ))}
          </AriaMenu>
        </AriaPopover>
      </MenuTrigger>
    </div>
  );
}
