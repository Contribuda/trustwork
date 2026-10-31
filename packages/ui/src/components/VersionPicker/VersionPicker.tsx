import { useState } from 'react';
import { formatDate, t } from '../../i18n';
import { Select } from '../Select/Select';
import { StatusChip } from '../Badge/Badge';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import styles from './VersionPicker.module.css';

export type VersionItem = { id: string; version: string; date: string; isCurrent?: boolean | undefined; isStale?: boolean | undefined };

export type VersionPickerProps = {
  versions: readonly VersionItem[];
  selectedId: string;
  onChange: (id: string) => void;
  /** Id of the heading that describes the versioned content; focus moves there after a selection. */
  contentHeadingId?: string | undefined;
  className?: string | undefined;
};

function versionLabel(item: VersionItem): string {
  if (item.isCurrent) return t('version.current', { version: item.version });
  if (item.isStale) return t('version.stale', { version: item.version });
  return t('version.historical', { version: item.version, date: formatDate(item.date, 'short') });
}

/** Version selector (listbox); announces the selection and moves focus to the content heading. */
export function VersionPicker({ versions, selectedId, onChange, contentHeadingId, className }: VersionPickerProps) {
  const [announcement, setAnnouncement] = useState('');
  const selected = versions.find((v) => v.id === selectedId);
  return (
    <div className={className}>
      <div className={styles.row}>
        <Select
          label={t('version.pickerLabel')}
          options={versions.map((v) => ({ id: v.id, label: versionLabel(v) }))}
          selectedKey={selectedId}
          onSelectionChange={(key) => {
            const next = versions.find((v) => v.id === String(key));
            if (!next) return;
            onChange(next.id);
            setAnnouncement(t('version.selected', { version: next.version }));
            if (contentHeadingId) document.getElementById(contentHeadingId)?.focus();
          }}
          className={styles.select}
        />
        {selected?.isCurrent ? <StatusChip tone="success">{t('version.current', { version: selected.version })}</StatusChip> : null}
        {selected && !selected.isCurrent && !selected.isStale ? <StatusChip tone="info">{t('search.historicalLabel', { date: formatDate(selected.date) })}</StatusChip> : null}
        {selected?.isStale ? <StatusChip tone="warning">{t('version.stale', { version: selected.version })}</StatusChip> : null}
      </div>
      <VisuallyHidden as="div">
        <span role="status" aria-live="polite">
          {announcement}
        </span>
      </VisuallyHidden>
    </div>
  );
}

/** Static version pill for page headers. */
export function VersionPill({ version, state }: { version: string; state: 'current' | 'historical' | 'stale'; date?: string | undefined }) {
  const tone = state === 'current' ? 'success' : state === 'stale' ? 'warning' : 'info';
  const label = state === 'current' ? t('version.current', { version }) : state === 'stale' ? t('version.stale', { version }) : t('version.item', { version });
  return <StatusChip tone={tone}>{label}</StatusChip>;
}
