import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bell } from 'lucide-react';
import { Badge, EvidenceLabel, KindBadge, LifecycleChip, RecordStatusChip, RunStatusBadge, StatusChip } from '../src/components/Badge/Badge';
import { IconButton } from '../src/components/Button/Button';
import { t } from '../src/i18n';

const meta = { title: 'Primitives/Badge and status chips', component: StatusChip } satisfies Meta<typeof StatusChip>;
export default meta;
type Story = StoryObj;

const row = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' } as const;

export const CountBadge: Story = {
  render: () => (
    <div style={row}>
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <IconButton icon={Bell} aria-label={t('shell.notificationsCount', { count: 3 })} />
        <Badge count={3} className="" />
      </span>
      <Badge count={120} />
      <Badge count={0} />
      <Badge dot tone="danger" />
      <Badge count={7} tone="warning" />
      <Badge count={7} tone="neutral" />
    </div>
  ),
};

export const Record: Story = {
  render: () => (
    <div style={row}>
      <RecordStatusChip status="sourced" />
      <RecordStatusChip status="claimed" />
      <RecordStatusChip status="verified" />
      <RecordStatusChip status="verified" size="sm" />
    </div>
  ),
};

export const Evidence: Story = {
  render: () => (
    <div style={row}>
      <EvidenceLabel state="asserted" />
      <EvidenceLabel state="confirmed" />
      <EvidenceLabel state="disputed" />
      <EvidenceLabel state="superseded" />
    </div>
  ),
};

export const Kind: Story = {
  render: () => (
    <div style={row}>
      <KindBadge kind="goods" />
      <KindBadge kind="works" />
      <KindBadge kind="services" />
      <KindBadge kind="bundle" />
    </div>
  ),
};

export const Lifecycle: Story = {
  render: () => (
    <div style={row}>
      {(['draft', 'inReview', 'published', 'active', 'paused', 'closed', 'cancelled', 'expired', 'archived'] as const).map((state) => (
        <LifecycleChip key={state} state={state} />
      ))}
    </div>
  ),
};

export const RunStates: Story = {
  render: () => (
    <div style={row}>
      {(['proposed', 'authorized', 'reserved', 'queued', 'executing', 'pending', 'succeeded', 'failed', 'outcomeUnknown', 'reconciling', 'revoked'] as const).map((state) => (
        <RunStatusBadge key={state} state={state} />
      ))}
    </div>
  ),
};

export const CustomTones: Story = {
  render: () => (
    <div style={row}>
      <StatusChip tone="neutral">Сбор КП</StatusChip>
      <StatusChip tone="info">Переговоры</StatusChip>
      <StatusChip tone="success">Заказ принят</StatusChip>
      <StatusChip tone="warning">Нужно ваше решение</StatusChip>
      <StatusChip tone="danger">Спор</StatusChip>
    </div>
  ),
};
