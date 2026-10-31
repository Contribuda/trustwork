import type { Meta, StoryObj } from '@storybook/react-vite';
import { ComboBox, Select } from '../src/components/Select/Select';

const regions = [
  { id: 'msk', label: 'Ташкент' },
  { id: 'spb', label: 'Санкт-Петербург' },
  { id: 'nsk', label: 'Новосибирск' },
  { id: 'ekb', label: 'Екатеринбург' },
  { id: 'kzn', label: 'Казань', isDisabled: true },
];

const meta = { title: 'Forms/Select', component: Select, args: { label: 'Регион', options: regions, placeholder: 'Выберите регион' } } satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Selected: Story = { args: { defaultSelectedKey: 'spb' } };
export const Open: Story = { args: { defaultOpen: true, defaultSelectedKey: 'msk' } };
export const Error: Story = { args: { errorMessage: 'Выберите регион', isRequired: true } };
export const Disabled: Story = { args: { isDisabled: true, defaultSelectedKey: 'msk' } };

export const Combobox: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 20, maxWidth: 480 }}>
      <ComboBox label="Направление деятельности" options={regions} placeholder="Начните вводить название" description="Можно выбрать один вариант из списка." />
      <ComboBox label="Направление деятельности" options={regions} defaultInputValue="Ташкент" defaultSelectedKey="msk" />
      <ComboBox label="Направление деятельности" options={[]} emptyText="Ничего не нашли. Можно продолжить без выбора." />
      <ComboBox label="Регионы" options={regions} isLoading />
      <ComboBox label="Регион" options={regions} errorMessage="Выберите регион из списка" />
      <ComboBox label="Регион" options={regions} isDisabled defaultSelectedKey="spb" defaultInputValue="Санкт-Петербург" />
    </div>
  ),
};

export const ComboboxOpen: Story = {
  render: () => <ComboBox label="Регион" options={regions} defaultInputValue="Санкт" menuTrigger="focus" autoFocus />,
};
