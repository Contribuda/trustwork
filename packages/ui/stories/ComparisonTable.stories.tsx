import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ComparisonTable, type ComparisonCell } from '../src/components/ComparisonTable/ComparisonTable';
import { VersionPicker, VersionPill } from '../src/components/VersionPicker/VersionPicker';

const lines = [
  { id: 'l1', label: 'Фасадные панели, 120 м²', detail: 'Толщина 100 мм' },
  { id: 'l2', label: 'Крепёж', detail: 'Комплект на 120 м²' },
  { id: 'l3', label: 'Доставка', detail: 'До объекта' },
];
const offers = [
  { id: 'o1', supplier: 'Поставщик А', version: '2' },
  { id: 'o2', supplier: 'Поставщик Б', version: '1', isStale: true },
  { id: 'o3', supplier: 'Поставщик В', version: '3', isExcluded: true },
];
const cells: Record<string, Record<string, ComparisonCell>> = {
  l1: {
    o1: { kind: 'comparable', value: '1 250 000 сум' },
    o2: { kind: 'nonComparable', value: '10 800 сум за м²', reason: 'unit', detail: 'Поставщик указал цену за квадратный метр.' },
    o3: { kind: 'comparable', value: '1 310 000 сум' },
  },
  l2: {
    o1: { kind: 'comparable', value: '84 000 сум' },
    o2: { kind: 'nonComparable', reason: 'substitution', value: 'Крепёж другого типа' },
    o3: { kind: 'missing' },
  },
  l3: {
    o1: { kind: 'comparable', value: 'Включена' },
    o2: { kind: 'comparable', value: '35 000 сум' },
    o3: { kind: 'nonComparable', reason: 'missingLine' },
  },
};

const meta = {
  title: 'Data/ComparisonTable and VersionPicker',
  component: ComparisonTable,
  args: { caption: 'Сравнение предложений: фасадные панели', lines, offers, cells, totals: { o1: '1 334 000 сум', o2: null, o3: null }, onSelectOffer: () => undefined },
} satisfies Meta<typeof ComparisonTable>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Table: Story = {};
export const Accordion: Story = { args: { layout: 'accordion' } };
export const MobileViewport: Story = { globals: { viewport: { value: 'mobile375', isRotated: false } } };
export const WithoutTotals: Story = { render: (args) => <ComparisonTable caption={args.caption} lines={args.lines} offers={args.offers} cells={args.cells} /> };

const versions = [
  { id: 'v3', version: '3', date: '2026-10-20', isCurrent: true },
  { id: 'v2', version: '2', date: '2026-10-05' },
  { id: 'v1', version: '1', date: '2026-09-12', isStale: true },
];

function VersionDemo({ initial }: { initial: string }) {
  const [selected, setSelected] = useState(initial);
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <VersionPicker versions={versions} selectedId={selected} onChange={setSelected} contentHeadingId="versioned-heading" />
      <h2 id="versioned-heading" tabIndex={-1}>
        Потребность «Фасадные панели»
      </h2>
    </div>
  );
}

export const VersionPickerCurrent: Story = { render: () => <VersionDemo initial="v3" /> };
export const VersionPickerHistorical: Story = { render: () => <VersionDemo initial="v2" /> };
export const VersionPickerStale: Story = { render: () => <VersionDemo initial="v1" /> };
export const VersionPills: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12 }}>
      <VersionPill version="3" state="current" />
      <VersionPill version="2" state="historical" />
      <VersionPill version="1" state="stale" />
    </div>
  ),
};
