import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import type { SortDescriptor } from 'react-aria-components';
import { MoreHorizontal } from 'lucide-react';
import { Button, IconButton } from '../src/components/Button/Button';
import { KindBadge, StatusChip, type OfferKind } from '../src/components/Badge/Badge';
import { DataTable } from '../src/components/DataTable/DataTable';
import { Menu, MenuTrigger } from '../src/components/Menu/Menu';
import { t } from '../src/i18n';

type Rfq = { id: string; title: string; project: string; kind: OfferKind; status: string; deadline: string; offers: number };

const rows: Rfq[] = [
  { id: '1', title: 'Фасадные панели', project: 'Пример проекта А', kind: 'goods', status: 'Сбор предложений', deadline: '2026-11-03', offers: 3 },
  { id: '2', title: 'Монтаж перегородок', project: 'Пример проекта Б', kind: 'works', status: 'Переговоры', deadline: '2026-11-10', offers: 1 },
  { id: '3', title: 'Техническое обслуживание', project: 'Пример проекта А', kind: 'services', status: 'Черновик', deadline: '2026-11-20', offers: 0 },
  { id: '4', title: 'Комплект электрооборудования', project: 'Пример проекта В', kind: 'bundle', status: 'Заказ размещён', deadline: '2026-10-30', offers: 4 },
];

const columns = [
  { id: 'title', header: 'Потребность', cell: (r: Rfq) => <a href="#">{r.title}</a>, sortable: true, isRowHeader: true },
  { id: 'project', header: 'Проект', cell: (r: Rfq) => r.project, sortable: true },
  { id: 'kind', header: 'Вид', cell: (r: Rfq) => <KindBadge kind={r.kind} size="sm" /> },
  { id: 'status', header: 'Статус', cell: (r: Rfq) => <StatusChip size="sm">{r.status}</StatusChip> },
  { id: 'deadline', header: 'Срок', cell: (r: Rfq) => new Date(r.deadline).toLocaleDateString(), sortable: true },
  { id: 'offers', header: 'Предложения', cell: (r: Rfq) => r.offers, align: 'end' as const, sortable: true },
];

function Demo(props: Partial<React.ComponentProps<typeof DataTable<Rfq>>>) {
  const [sort, setSort] = useState<SortDescriptor>({ column: 'deadline', direction: 'ascending' });
  const sorted = useMemo(() => {
    const list = [...rows];
    const key = String(sort.column) as keyof Rfq;
    list.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (sort.direction === 'descending' ? -1 : 1));
    return list;
  }, [sort]);
  return (
    <DataTable<Rfq>
      caption="Потребности в работе"
      columns={columns}
      rows={sorted}
      rowKey={(r) => r.id}
      sort={sort}
      onSortChange={setSort}
      rowActions={(r) => (
        <MenuTrigger>
          <IconButton icon={MoreHorizontal} aria-label={`${t('table.rowActions')}: ${r.title}`} size="sm" />
          <Menu aria-label={t('table.rowActions')} items={[{ id: 'open', label: 'Открыть' }, { id: 'close', label: 'Закрыть', isDestructive: true }]} />
        </MenuTrigger>
      )}
      {...props}
    />
  );
}

const meta = { title: 'Data/DataTable', component: DataTable } satisfies Meta<typeof DataTable>;
export default meta;
type Story = StoryObj;

export const Sorted: Story = { render: () => <Demo /> };
export const Cards: Story = { render: () => <Demo layout="cards" /> };
export const MobileViewport: Story = { render: () => <Demo />, globals: { viewport: { value: 'mobile375', isRotated: false } } };
export const Loading: Story = { render: () => <Demo state="loading" /> };
export const Empty: Story = { render: () => <Demo rows={[]} emptyTitle="Потребностей пока нет" emptyBody="Создайте первую потребность или импортируйте запрос из письма." /> };
export const ErrorState: Story = { render: () => <Demo state="error" errorAction={<Button variant="secondary">{t('common.retry')}</Button>} /> };
