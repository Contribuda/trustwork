import type { Meta, StoryObj } from '@storybook/react-vite';
import { Band } from '../src/components/Band/Band';
import { Button, ButtonLink } from '../src/components/Button/Button';
import { Hero } from '../src/components/Hero/Hero';
import { Link } from '../src/components/Link/Link';
import { MagazineCover } from '../src/components/MagazineCover/MagazineCover';
import { MediaFrame } from '../src/components/MediaFrame/MediaFrame';
import { Prose } from '../src/components/Prose/Prose';
import { Quote } from '../src/components/Quote/Quote';
import { SectionHeader } from '../src/components/SectionHeader/SectionHeader';
import { StoryCard } from '../src/components/StoryCard/StoryCard';
import { Heading, Text } from '../src/components/Typography/Typography';
import { t } from '../src/i18n';
import { photo } from '../src/media/index';
import { archiveIssues, magazineIssue, newsItems, stories } from './editorial-fixtures';

const meta = { title: 'Editorial/Hero, cards, bands', component: Hero } satisfies Meta<typeof Hero>;
export default meta;
type Story = StoryObj;

const lead = stories[0];

export const HeroLead: Story = {
  render: () => <Hero media={photo('cranes-sky')} kicker="В фокусе" title="Как меняется строительство" dek="Материалы, технологии и решения — в одном обзоре." meta={['Обзор', '8 минут']} href="#lead" />,
};

export const HeroMedium: Story = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <Hero size="md" headingLevel={2} media={lead.media} kicker={lead.kicker} title={lead.title} dek={lead.dek} meta={[...lead.meta]} href={lead.href} />
    </div>
  ),
};

export const HeroMobile: Story = { ...HeroLead, globals: { viewport: { value: 'mobile375', isRotated: false } } };

export const StoryCards: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }} className="trustwork-enter-group">
      {stories.slice(0, 3).map((item, index) => (
        <StoryCard key={item.id} {...item} chips={[...item.chips]} meta={[...item.meta]} enterIndex={index} />
      ))}
    </div>
  ),
};

export const StoryCardSizes: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24 }}>
      <StoryCard size="l" {...stories[1]} chips={[...stories[1].chips]} meta={[...stories[1].meta]} headingLevel={2} />
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
        {stories.slice(2, 5).map((item) => (
          <StoryCard key={item.id} size="s" {...item} chips={[...item.chips]} meta={[...item.meta]} />
        ))}
      </div>
    </div>
  ),
};

export const StoryCardHorizontal: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, maxWidth: 760 }}>
      {stories.slice(1, 4).map((item) => (
        <StoryCard key={item.id} layout="horizontal" {...item} chips={[...item.chips]} meta={[...item.meta]} />
      ))}
      <StoryCard layout="horizontal" size="s" {...stories[4]} chips={[...stories[4].chips]} meta={[...stories[4].meta]} />
    </div>
  ),
};

export const StoryCardTextOnly: Story = {
  name: 'StoryCard without media (news tiles)',
  render: () => (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
      {newsItems.map((item) => (
        <StoryCard key={item.href} size="s" kicker={item.kicker} title={item.title} meta={[...item.meta]} href={item.href} />
      ))}
    </div>
  ),
};

export const SectionHeaders: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 40, maxWidth: 960 }}>
      <SectionHeader title="Сейчас в отрасли" action={<Link variant="standalone" href="#">Все новости</Link>} />
      <SectionHeader kicker="Журнал" title="Неделя в одном выпуске" description="Отобранное редакцией: важное, полезное, интересное." action={<Link variant="standalone" href="#">Архив журнала</Link>} />
      <SectionHeader size="lg" headingLevel={1} title="Компании, которые создают отрасль" description="Знакомьтесь с опытом, проектами и публикациями. Находите партнёров по делу." action={<Button variant="secondary">Представить компанию</Button>} />
      <SectionHeader size="sm" headingLevel={3} title="Полезно под рукой" />
    </div>
  ),
};

export const Bands: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24 }}>
      <Band tone="navy" aria-label="Продолжите в рабочем пространстве">
        <SectionHeader tone="inverse" kicker="О платформе" title="Продолжите в своём рабочем пространстве" description="Сохраняйте полезное, работайте над проектами и поручайте задачи помощнику." action={<ButtonLink href="#" variant="accent">Войти в сервис</ButtonLink>} />
      </Band>
      <Band tone="navy" backdrop={photo('aerial-site-foundations')} aria-label="У компании есть своя история">
        <SectionHeader tone="inverse" title="У компании есть своя история. Покажите её." description="Профиль, проекты и публикации — в одном месте." action={<ButtonLink href="#" variant="accent">Создать страницу компании</ButtonLink>} />
      </Band>
      <Band tone="tint" padding="sm" aria-label="Журнал">
        <Text>Светло-синяя полоса для журнала и подборок.</Text>
      </Band>
      <Band tone="warm" padding="sm" aria-label="Тёплая полоса">
        <Text>Тёплая песочная полоса для спокойных секций.</Text>
      </Band>
    </div>
  ),
};

export const MagazineCovers: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 40 }}>
      <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <MagazineCover {...magazineIssue} href="#issue-12" />
        <div style={{ maxWidth: 440, display: 'grid', gap: 16 }}>
          <Text tone="muted" styleAs="bodySm">
            {t('magazine.fresh')} · {t('magazine.issue', { number: magazineIssue.issue })} · {magazineIssue.dateRange}
          </Text>
          <Heading level={2} styleAs="h1">
            {magazineIssue.title}
          </Heading>
          <Text styleAs="bodyLg" tone="muted">
            {magazineIssue.summary}
          </Text>
          <div style={{ display: 'flex', gap: 12 }}>
            <ButtonLink href="#read">{t('magazine.read')}</ButtonLink>
            <ButtonLink href="#archive" variant="secondary">
              {t('magazine.archive')}
            </ButtonLink>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {archiveIssues.map((issue) => (
          <MagazineCover key={issue.issue} size="md" {...issue} href={`#issue-${issue.issue}`} />
        ))}
        <MagazineCover size="sm" {...archiveIssues[0]} tilt={false} />
      </div>
    </div>
  ),
};

export const PullQuote: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 40, maxWidth: 720 }}>
      <Quote cite="Инженер-технолог" source="Интервью редакции">
        Хороший выбор начинается с правильных вопросов.
      </Quote>
      <Quote variant="inline" cite="Анна Примерова">
        Поэтапная приёмка снимает споры в конце объекта: каждый этап закрывается актом и фотографиями.
      </Quote>
      <div style={{ background: 'var(--color-navy)', padding: 32, borderRadius: 16 }}>
        <Quote tone="inverse" cite="Редакция">
          Материалы задают тон проекту.
        </Quote>
      </div>
    </div>
  ),
};

export const ArticleProse: Story = {
  render: () => (
    <Prose>
      <Heading level={1} styleAs="h1">
        Характер начинается с фактуры
      </Heading>
      <p>Материалы задают тон проекту. Они определяют, как здание взаимодействует с человеком, городом и временем. Выбор материала — это всегда больше, чем техническая задача.</p>
      <p>
        За ним стоят эстетика, эксплуатация, экономика и, главное, люди, которые будут жить и работать в созданной среде. Современные решения дают архитекторам и девелоперам всё больше возможностей — важно уметь внимательно к ним относиться. Подробнее — в <a href="#">разборе о сравнении предложений</a>.
      </p>
      <figure>
        <MediaFrame media={photo('wood-planks')} ratio="16/10" />
        <figcaption>Фактура, которая работает в пространстве. Иллюстрация: артворк дизайн-системы.</figcaption>
      </figure>
      <h2>На что смотреть в деталях</h2>
      <ol>
        <li>
          <strong>Назначение и контекст.</strong> Один и тот же материал может работать по-разному в зависимости от задачи, климата и окружения.
        </li>
        <li>
          <strong>Эксплуатационные качества.</strong> Важно учитывать долговечность, устойчивость к нагрузкам и простоту обслуживания.
        </li>
        <li>
          <strong>Ответственность и происхождение.</strong> Всё больше проектов выбирают материалы с понятным происхождением и прозрачной логикой поставок.
        </li>
      </ol>
      <blockquote>
        <p>Хороший выбор начинается с правильных вопросов.</p>
      </blockquote>
      <h3>Сравнение по единицам</h3>
      <table>
        <caption>Пример приведения предложений к одной единице</caption>
        <thead>
          <tr>
            <th scope="col">Поставщик</th>
            <th scope="col">Единица</th>
            <th scope="col" data-align="num">
              Цена за м²
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Поставщик А</td>
            <td>упаковка 2,4 м²</td>
            <td data-align="num">1 250 сум</td>
          </tr>
          <tr>
            <td>Поставщик Б</td>
            <td>м²</td>
            <td data-align="num">1 190 сум</td>
          </tr>
        </tbody>
      </table>
      <p className="note">Цены условные, для иллюстрации метода.</p>
    </Prose>
  ),
};
