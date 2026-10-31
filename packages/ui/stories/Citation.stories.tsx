import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { AnswerStatusLine, CitationChip, CitationDetails, RetrievalStatusBanner } from '../src/components/Citation/Citation';
import { EvidenceList, Timeline } from '../src/components/Timeline/Timeline';

const meta = { title: 'Retrieval/Citations and retrieval states', component: CitationChip } satisfies Meta<typeof CitationChip>;
export default meta;
type Story = StoryObj;

export const ChipStates: Story = {
  render: () => (
    <p style={{ maxWidth: 640, lineHeight: 1.8 }}>
      Компания указала объём работ 120 м² <CitationChip index={1} /> и срок поставки 14 дней <CitationChip index={2} state={{ kind: 'historical', date: '2026-09-12' }} />; одно из подтверждений больше недоступно{' '}
      <CitationChip index={3} state={{ kind: 'unavailable', reason: 'revoked' }} />. Открытый источник: <CitationChip index={4} isExpanded />.
    </p>
  ),
};

function DrawerDemo() {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
      <p>
        Срок поставки 14 дней <CitationChip index={1} isExpanded={open} onPress={() => setOpen((v) => !v)} describedBy="citation-1-heading" />
      </p>
      {open ? (
        <aside aria-labelledby="citation-1-heading" style={{ border: '1px solid var(--color-border)', borderRadius: 12, padding: 16, background: '#fff' }}>
          <CitationDetails headingId="citation-1-heading" sourceTitle="Коммерческое предложение, версия 2" sourceKind="Предложение" version="2" date="2026-10-05" projection="Сторона сделки" locator={{ kind: 'table', page: 2, table: '1', row: '3' }} evidence="confirmed" href="#" />
        </aside>
      ) : null}
    </div>
  );
}

export const DrawerAvailable: Story = { render: () => <DrawerDemo /> };
export const DrawerUnavailable: Story = {
  render: () => (
    <div style={{ maxWidth: 480, border: '1px solid var(--color-border)', borderRadius: 12, padding: 16, background: '#fff' }}>
      <CitationDetails headingId="c2" sourceTitle="Внутренний документ" sourceKind="Файл" version="1" date="2026-08-01" locator={{ kind: 'page', page: 4 }} evidence="superseded" unavailable="scope" />
    </div>
  ),
};
export const DrawerHistorical: Story = {
  render: () => (
    <div style={{ maxWidth: 480, border: '1px solid var(--color-border)', borderRadius: 12, padding: 16, background: '#fff' }}>
      <CitationDetails headingId="c3" sourceTitle="Карточка компании" sourceKind="Компания" version="7" date="2026-06-15" locator={{ kind: 'text' }} evidence="asserted" historical href="#" />
    </div>
  ),
};

export const AnswerStatuses: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
      <AnswerStatusLine status="supported" />
      <AnswerStatusLine status="qualified" reason="часть источников недоступна" />
      <AnswerStatusLine status="qualified" reason="данные за прошлый период" scopeIncomplete />
      <AnswerStatusLine status="abstain" />
    </div>
  ),
};

export const RetrievalBanners: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
      <RetrievalStatusBanner status="partial" reason="budget" />
      <RetrievalStatusBanner status="partial" reason="semanticOff" />
      <RetrievalStatusBanner status="noAnswer" />
      <RetrievalStatusBanner status="unavailable" onRetry={() => undefined} />
      <RetrievalStatusBanner status="stale" onRetry={() => undefined} />
      <RetrievalStatusBanner status="previousShown" onRetry={() => undefined} />
      <RetrievalStatusBanner status="historical" date="2026-09-12" onBackToCurrent={() => undefined} />
      <RetrievalStatusBanner status="offline" />
    </div>
  ),
};

export const TimelineStory: Story = {
  name: 'Timeline',
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <Timeline
        events={[
          { id: '1', title: 'Поставка материалов', at: '2026-10-01', mark: 'baseline', meta: 'План' },
          { id: '2', title: 'Поставка материалов перенесена', at: '2026-10-08', mark: 'changed', description: 'Срок изменён по согласованию сторон.', evidence: 'confirmed' },
          { id: '3', title: 'Приёмка работ', at: '2026-10-20', mark: 'done' },
          { id: '4', title: 'Акт оспорен заказчиком', at: '2026-10-22', mark: 'disputed', evidence: 'disputed' },
          { id: '5', title: 'Оплата поставщику', mark: 'outcomeUnknown', description: 'Внешняя система не ответила. Мы сверяем результат.' },
          { id: '6', title: 'Закрытие проекта', mark: 'pending' },
        ]}
      />
    </div>
  ),
};

export const EvidenceListStory: Story = {
  name: 'EvidenceList',
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <EvidenceList
        label="Подтверждения"
        items={[
          { id: 'e1', title: 'Выписка из реестра', state: 'confirmed', source: 'Открытый реестр', observedAt: '2026-10-01', href: '#' },
          { id: 'e2', title: 'Заявление компании об опыте', state: 'asserted', source: 'Страница компании', observedAt: '2026-09-20' },
          { id: 'e3', title: 'Отзыв заказчика', state: 'disputed', source: 'Проект', observedAt: '2026-09-28' },
          { id: 'e4', title: 'Старая версия каталога', state: 'superseded', source: 'Каталог' },
        ]}
      />
    </div>
  ),
};
