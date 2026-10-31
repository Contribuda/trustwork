import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tabs } from '../src/components/Tabs/Tabs';

const meta = { title: 'Navigation/Tabs', component: Tabs } satisfies Meta<typeof Tabs>;
export default meta;
type Story = StoryObj<typeof meta>;

const tabs = [
  { id: 'conversation', label: 'Разговор', content: <p>Разговор с помощником.</p> },
  { id: 'mandates', label: 'Поручения', content: <p>Список поручений.</p> },
  { id: 'approvals', label: 'Согласования', content: <p>Решений не требуется.</p> },
  { id: 'runs', label: 'Запуски', content: <p>Запусков пока нет.</p>, isDisabled: true },
];

export const Default: Story = { args: { 'aria-label': 'Разделы помощника', tabs: [{ id: 'conversation', label: 'Разговор', content: <p>Разговор с помощником.</p> }, ...tabs.slice(1)] } };
export const SecondSelected: Story = { args: { ...Default.args, defaultSelectedKey: 'mandates' } };
export const Overflow: Story = {
  args: {
    'aria-label': 'Разделы компании',
    tabs: ['Обзор', 'Каталог', 'Проекты', 'Люди', 'Публикации', 'Репутация', 'Документы', 'Переписка', 'История согласований', 'Бюджет', 'Участники'].map((label, i) => ({ id: String(i), label, content: <p>{label}</p> })),
  },
  globals: { viewport: { value: 'mobile375', isRotated: false } },
};
