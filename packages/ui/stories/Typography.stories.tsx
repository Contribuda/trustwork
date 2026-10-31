import type { Meta, StoryObj } from '@storybook/react-vite';
import { Clock } from 'lucide-react';
import { Icon } from '../src/components/Icon/Icon';
import { Heading, Kicker, Meta as MetaRow, Text } from '../src/components/Typography/Typography';

const meta = { title: 'Primitives/Typography', component: Heading } satisfies Meta<typeof Heading>;
export default meta;
type Story = StoryObj;

export const Scale: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 32, maxWidth: 960 }}>
      <div>
        <Kicker>display · 56/1.05 · −0.02em</Kicker>
        <Heading level={1} styleAs="display">
          Как меняется строительство
        </Heading>
      </div>
      <div>
        <Kicker>h1 · 40/1.1 · −0.015em</Kicker>
        <Heading level={2} styleAs="h1">
          Компании, которые создают отрасль
        </Heading>
      </div>
      <div>
        <Kicker>h2 · 28/1.2</Kicker>
        <Heading level={2}>Сейчас в отрасли</Heading>
      </div>
      <div>
        <Kicker>h3 · 22/1.25</Kicker>
        <Heading level={3}>Как сравнивать предложения на фасадные панели</Heading>
      </div>
      <div>
        <Kicker>h4 · 18/1.35</Kicker>
        <Heading level={4}>Полезно под рукой</Heading>
      </div>
      <div>
        <Kicker>body-lg · 18/1.6</Kicker>
        <Text styleAs="bodyLg">Отобранное редакцией: важное, полезное, интересное. Находите людей и компании, делитесь опытом и работайте над проектами.</Text>
      </div>
      <div>
        <Kicker>body · 16/1.6</Kicker>
        <Text>Единицы измерения, объёмы и замены — три причины, по которым два предложения нельзя сравнивать по одной цифре.</Text>
      </div>
      <div>
        <Kicker>small · 14/1.5</Kicker>
        <Text styleAs="bodySm" tone="muted">
          Справочник с пометками: по открытым источникам, заявлено компанией, подтверждено.
        </Text>
      </div>
      <div>
        <Kicker>kicker · 12 · +0.08em</Kicker>
        <Kicker>Материалы</Kicker>
      </div>
      <div>
        <Kicker>serif · PT Serif 19/1.65</Kicker>
        <Text styleAs="serif">Выбор материала — это всегда больше, чем техническая задача. За ним стоят эстетика, эксплуатация, экономика и, главное, люди, которые будут жить и работать в созданной среде.</Text>
      </div>
      <div>
        <Kicker>tabular figures</Kicker>
        <Text tabular>
          1 250 000 сум · 48 страниц · 8 материалов
        </Text>
      </div>
    </div>
  ),
};

export const MetaRows: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
      <MetaRow items={['Редакция', '21 октября 2026', '6 мин']} />
      <MetaRow items={['Анна Примерова', '10 октября 2026', '4 мин']} icon={<Icon icon={Clock} size={16} />} />
      <MetaRow items={['Закупка', '3 предложения на версию 2', null, 'Срок: 2 ноября 2026']} size="caption" />
      <div style={{ background: 'var(--color-navy)', padding: 16, borderRadius: 12 }}>
        <MetaRow items={['Обзор', '8 минут']} tone="inverse" />
      </div>
    </div>
  ),
};

export const Tones: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
      <Text>Основной текст (ink)</Text>
      <Text tone="muted">Второстепенный текст (muted, ≥ 4.5:1)</Text>
      <Text tone="subtle">Подсказки и метки (subtle, ≥ 4.5:1)</Text>
      <Text tone="accent" weight="medium">
        Акцентный текст (blue 600)
      </Text>
      <div style={{ background: 'var(--color-navy)', padding: 16, borderRadius: 12, display: 'grid', gap: 8 }}>
        <Text tone="inverse">Текст на тёмной полосе</Text>
        <Text tone="inverseMuted">Второстепенный текст на тёмной полосе</Text>
      </div>
    </div>
  ),
};
