import type { Meta, StoryObj } from '@storybook/react-vite';
import { Building2, SearchX, ShieldAlert } from 'lucide-react';
import { Button } from '../src/components/Button/Button';
import { Card, CardLink } from '../src/components/Card/Card';
import { EmptyState } from '../src/components/EmptyState/EmptyState';
import { Skeleton, SkeletonGroup } from '../src/components/Skeleton/Skeleton';
import { Link } from '../src/components/Link/Link';
import { t } from '../src/i18n';

const meta = { title: 'Primitives/Skeleton, EmptyState, Card', component: EmptyState } satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj;

export const Skeletons: Story = {
  render: () => (
    <SkeletonGroup label={t('common.loading')} className="">
      <div style={{ display: 'grid', gap: 24, maxWidth: 640 }}>
        <Skeleton lines={3} />
        <Skeleton variant="card" />
        <Skeleton variant="row" lines={2} />
        <Skeleton variant="circle" />
        <Skeleton variant="table" lines={3} />
      </div>
    </SkeletonGroup>
  ),
};

export const Empty: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, maxWidth: 640 }}>
      <EmptyState
        icon={Building2}
        title="Компания пока не привязана"
        actions={
          <>
            <Button>Представить компанию</Button>
            <Button variant="secondary">Присоединиться</Button>
          </>
        }
      >
        Можно продолжить без компании: личные настройки и публикации доступны сразу.
      </EmptyState>
      <EmptyState icon={SearchX} title={t('search.status.noAnswer')} headingLevel={3} />
    </div>
  ),
};

export const ErrorAndDenied: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, maxWidth: 640 }}>
      <EmptyState tone="error" title={t('common.sectionLoadError')} actions={<Button variant="secondary">{t('common.retry')}</Button>} />
      <EmptyState tone="denied" icon={ShieldAlert} title={t('common.noAccessTitle')}>
        {t('common.noAccessBody')}
      </EmptyState>
    </div>
  ),
};

export const Cards: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
      <Card title="Закупки" id="purchases" aside={<Link variant="standalone" href="#">Все</Link>} footer={<Link variant="standalone" href="#">Найти поставщика</Link>}>
        <p>Три потребности в работе.</p>
      </Card>
      <Card padding="sm" headingLevel={3} title="Выбрано">
        <p>Карточка с меньшими отступами.</p>
      </Card>
      <Card padding="md" isSelected>
        <CardLink href="#">Пример проекта</CardLink>
        <p style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>Следующий этап: поставка материалов</p>
      </Card>
      <Card padding="md">
        <CardLink href="#">Интерактивная карточка</CardLink>
        <p style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>Одна основная ссылка на всю карточку.</p>
      </Card>
    </div>
  ),
};
