import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { RemovableTag, TagSelect, type TagOption } from '../src/components/TagSelect/TagSelect';
import { locale, t } from '../src/i18n';

const meta = { title: 'Forms/TagSelect', component: TagSelect } satisfies Meta<typeof TagSelect>;
export default meta;
type Story = StoryObj;


const capabilities: TagOption[] = [
  { id: 'buy', label: locale.onboarding[0] ?? '', description: 'Ищу поставщиков, сравниваю предложения и организую закупки.' },
  { id: 'sell', label: locale.onboarding[1] ?? '', description: 'Предлагаю товары, работы или услуги и нахожу клиентов.' },
  { id: 'industry', label: locale.onboarding[2] ?? '', description: 'Читаю, публикую статьи и новости, делюсь опытом.' },
];

function Demo({ appearance, initial = [] as string[], options = capabilities }: { appearance: 'pill' | 'card'; initial?: string[]; options?: TagOption[] }) {
  const [selected, setSelected] = useState<string[]>(initial);
  return <TagSelect label={t('onboardingFlow.selectionLabel')} description={t('onboardingFlow.multiHint')} options={options} selected={selected} onChange={setSelected} appearance={appearance} />;
}

export const Cards: Story = { render: () => <Demo appearance="card" /> };
export const CardsSelected: Story = { render: () => <Demo appearance="card" initial={['buy', 'industry']} /> };
export const Pills: Story = {
  render: () => (
    <Demo
      appearance="pill"
      initial={['concrete']}
      options={[
        { id: 'concrete', label: 'Бетон и ЖБИ' },
        { id: 'facade', label: 'Фасады' },
        { id: 'electric', label: 'Электрика' },
        { id: 'roof', label: 'Кровля', isDisabled: true },
      ]}
    />
  ),
};
export const Removable: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <RemovableTag label="Регион: Ташкент" onRemove={() => undefined} />
      <RemovableTag label="Вид: Работы" onRemove={() => undefined} />
    </div>
  ),
};
