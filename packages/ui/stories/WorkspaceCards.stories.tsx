import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Building2 } from 'lucide-react';
import { Button } from '../src/components/Button/Button';
import { DateTile, EventList } from '../src/components/DateTile/DateTile';
import { DecisionCard } from '../src/components/DecisionCard/DecisionCard';
import { DemoBanner } from '../src/components/DemoBanner/DemoBanner';
import { EmptyState } from '../src/components/EmptyState/EmptyState';
import { EntityCard } from '../src/components/EntityCard/EntityCard';
import { FormAlert } from '../src/components/Form/Form';
import { t } from '../src/i18n';
import { artwork } from '../src/media/index';
import { companies, decisions, events, people, personas, projects } from './editorial-fixtures';

const meta = { title: 'Workspace/Decision, entity, events', component: DecisionCard } satisfies Meta<typeof DecisionCard>;
export default meta;
type Story = StoryObj;

export const DecisionCards: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, maxWidth: 820 }} className="trustwork-enter-group">
      {decisions.map((item, index) => (
        <DecisionCard key={item.title} {...item} meta={[...item.meta]} enterIndex={index}>
          {item.tone === 'assistant' ? <FormAlert tone="warning">Условия изменились, проверьте заново</FormAlert> : null}
        </DecisionCard>
      ))}
    </div>
  ),
};

export const EntityCards: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }} className="trustwork-enter-group">
      {companies.map((company, index) => (
        <EntityCard key={company.name} kind="company" href="#" {...company} facts={[...company.facts]} meta={[...company.meta]} enterIndex={index} />
      ))}
      {people.map((person, index) => (
        <EntityCard key={person.name} kind="person" href="#" {...person} facts={[...person.facts]} enterIndex={index + 3} />
      ))}
      {projects.map((project, index) => (
        <EntityCard key={project.name} kind="project" href="#" {...project} facts={[...project.facts]} enterIndex={index + 5} />
      ))}
    </div>
  ),
};

export const EntityCardsHorizontal: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
      <EntityCard layout="horizontal" kind="company" href="#" {...companies[0]} facts={[...companies[0].facts]} meta={[...companies[0].meta]} />
      <EntityCard layout="horizontal" kind="person" href="#" {...people[0]} facts={[...people[0].facts]} />
      <EntityCard layout="horizontal" kind="project" href="#" {...projects[0]} facts={[...projects[0].facts]} />
    </div>
  ),
};

export const DatesAndEvents: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 32, maxWidth: 560 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <DateTile date="2026-10-27" />
        <DateTile date="2026-10-29" tone="accent" />
        <DateTile date="2026-11-02" tone="warning" />
        <DateTile date="2026-11-10" size="sm" />
      </div>
      <EventList label={t('events.upcoming')} items={events} />
    </div>
  ),
};

function DemoBannerDemo() {
  const [current, setCurrent] = useState<string>('guest');
  return <DemoBanner personas={personas} currentId={current} onChange={setCurrent} />;
}

export const DemoStrip: Story = {
  name: 'DemoBanner (32 px strip)',
  render: () => (
    <div style={{ background: 'var(--color-canvas)' }}>
      <DemoBannerDemo />
      <div style={{ padding: 24 }}>Содержимое страницы под полосой.</div>
    </div>
  ),
};

export const EmptyWithIllustration: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, maxWidth: 640 }}>
      <EmptyState illustration="auto" title="Компания пока не привязана" actions={<Button>Представить компанию</Button>}>
        Можно продолжить без компании: личные настройки и публикации доступны сразу.
      </EmptyState>
      <EmptyState illustration={artwork('blueprint-lines')} icon={Building2} title="Пока нет проектов" headingLevel={3} variant="plain">
        Создайте первый проект или примите приглашение.
      </EmptyState>
    </div>
  ),
};
