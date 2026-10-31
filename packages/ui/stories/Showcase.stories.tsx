import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Building2, FileText, FolderKanban, Home as HomeIcon, Plus, ShoppingCart, Sparkles, TrendingUp, User } from 'lucide-react';
import { AppHeader } from '../src/components/AppHeader/AppHeader';
import { Band } from '../src/components/Band/Band';
import { Button, ButtonLink } from '../src/components/Button/Button';
import { Card } from '../src/components/Card/Card';
import { DateTile, EventList } from '../src/components/DateTile/DateTile';
import { DecisionCard } from '../src/components/DecisionCard/DecisionCard';
import { DemoBanner } from '../src/components/DemoBanner/DemoBanner';
import { EntityCard } from '../src/components/EntityCard/EntityCard';
import { Hero } from '../src/components/Hero/Hero';
import { Link } from '../src/components/Link/Link';
import { MagazineCover } from '../src/components/MagazineCover/MagazineCover';
import { MediaFrame } from '../src/components/MediaFrame/MediaFrame';
import { Prose } from '../src/components/Prose/Prose';
import { PublicFooter } from '../src/components/PublicShell/PublicFooter';
import { PublicHeader } from '../src/components/PublicShell/PublicHeader';
import { Quote } from '../src/components/Quote/Quote';
import { SectionHeader } from '../src/components/SectionHeader/SectionHeader';
import { SidebarNav, type SidebarNavItem } from '../src/components/SidebarNav/SidebarNav';
import { StoryCard } from '../src/components/StoryCard/StoryCard';
import { Heading, Kicker, Meta as MetaRow, Text } from '../src/components/Typography/Typography';
import { locale, t } from '../src/i18n';
import { artwork, artworkFor } from '../src/media/index';
import { cx } from '../src/utils/cx';
import { archiveIssues, companies, decisions, events, magazineIssue, newsItems, people, personas, projects, stories } from './editorial-fixtures';
import { avatarMenuItems } from './fixtures';
import styles from './showcase.module.css';

const hrefs = ['/', '/news', '/articles', '/events', '/companies', '/people', '/projects', '/magazine'] as const;

const meta = { title: 'Showcase/Compositions', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;

function DemoStrip() {
  const [current, setCurrent] = useState<string>('guest');
  return <DemoBanner personas={personas} currentId={current} onChange={setCurrent} />;
}

function HomePage() {
  const lead = stories[0];
  return (
    <div style={{ background: 'var(--color-canvas)' }}>
      <DemoStrip />
      <PublicHeader hrefs={hrefs} currentIndex={0} brandHref="/" aboutHref="/about" onSearchPress={() => undefined} signInHref="/login" />
      <main id="main">
        <section className={cx('trustwork-container trustwork-enter-group', styles.lead)} aria-label="Главное">
          <Hero size="md" media={artworkFor('cranes-sky')} kicker="В фокусе" title="Как меняется строительство" dek="Материалы, технологии и решения — в одном обзоре." meta={['Обзор', '8 минут']} href={lead.href} />
          <div className={styles.leadSide}>
            <Hero size="sm" headingLevel={2} media={stories[1].media} kicker="Материалы" title="Из чего складывается качество" meta={['Разбор', '6 минут']} href={stories[1].href} />
            <Hero size="sm" headingLevel={2} media={artworkFor('timber-framing')} kicker="Проекты" title="Каркас, который видно: школа на набережной" meta={['История проекта', '7 минут']} href={stories[3].href} />
          </div>
        </section>

        <section className="trustwork-container trustwork-section" aria-labelledby="now-title">
          <SectionHeader id="now-title" title="Сейчас в отрасли" action={<Link variant="standalone" href="/news">Все новости</Link>} />
          <div className={cx('trustwork-enter-group', styles.cols4, styles.sectionGap)}>
            {newsItems.map((item) => (
              <StoryCard key={item.href} size="s" kicker={item.kicker} title={item.title} meta={[...item.meta]} href={item.href} />
            ))}
          </div>
        </section>

        <section className="trustwork-container" style={{ paddingBottom: 'var(--space-section)' }} aria-labelledby="articles-title">
          <SectionHeader id="articles-title" title="Статьи и разборы" action={<Link variant="standalone" href="/articles">Все статьи</Link>} />
          <div className={cx(styles.mainAside, styles.sectionGap)}>
            <div className={cx('trustwork-enter-group', styles.stack)}>
              {stories.slice(1, 5).map((item) => (
                <StoryCard key={item.id} layout="horizontal" {...item} chips={[...item.chips]} meta={[...item.meta]} />
              ))}
            </div>
            <div className={styles.aside}>
              <Card title="Полезно под рукой" headingLevel={3} id="handy">
                <ul style={{ display: 'grid', gap: 8, padding: 0, listStyle: 'none' }}>
                  <li>
                    <Link href="#">Проверка предложения</Link>
                  </li>
                  <li>
                    <Link href="#">Словарь материалов</Link>
                  </li>
                  <li>
                    <Link href="#">Вопросы поставщику</Link>
                  </li>
                </ul>
              </Card>
              <Card title="Есть чем поделиться?" headingLevel={3} id="share">
                <Text tone="muted" styleAs="bodySm">
                  Опубликуйте статью от себя или от компании.
                </Text>
                <div style={{ marginTop: 12 }}>
                  <Button variant="secondary">Стать автором</Button>
                </div>
              </Card>
            </div>
          </div>
        </section>

        <Band tone="tint" aria-labelledby="magazine-title">
          <div className={styles.magazine}>
            <MagazineCover {...magazineIssue} href="/magazine/12" />
            <div className={styles.magazineText}>
              <Kicker>Журнал</Kicker>
              <Heading level={2} styleAs="h1" id="magazine-title">
                Неделя в одном выпуске
              </Heading>
              <MetaRow items={[t('magazine.fresh'), t('magazine.issue', { number: magazineIssue.issue }), magazineIssue.dateRange]} />
              <Text styleAs="bodyLg" tone="muted">
                {magazineIssue.summary}
              </Text>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <ButtonLink href="/magazine/12">{t('magazine.read')}</ButtonLink>
                <ButtonLink href="/magazine" variant="secondary">
                  {t('magazine.archive')}
                </ButtonLink>
              </div>
            </div>
          </div>
        </Band>

        <section className="trustwork-container trustwork-section" aria-labelledby="who-title">
          <SectionHeader id="who-title" title="Кто и что создаёт отрасль" description="Справочник с пометками: по открытым источникам, заявлено компанией, подтверждено." />
          <div className={cx('trustwork-enter-group', styles.cols3, styles.sectionGap)}>
            <EntityCard kind="company" href="#" {...companies[0]} facts={[...companies[0].facts]} meta={[...companies[0].meta]} />
            <EntityCard kind="person" href="#" {...people[0]} facts={[...people[0].facts]} />
            <EntityCard kind="project" href="#" {...projects[0]} facts={[...projects[0].facts]} />
          </div>
        </section>

        <Band tone="navy" backdrop={artwork('glass-night')} padding="lg" aria-labelledby="cta-title">
          <div className={styles.cta}>
            <SectionHeader tone="inverse" kicker="О платформе" id="cta-title" title="Продолжите в своём рабочем пространстве" description="Личная страница, компания, проекты, закупки, продажи и публикации — в одном рабочем пространстве с одним помощником." />
            <div className={styles.ctaActions}>
              <ButtonLink href="/about" variant="secondary">
                Узнать о платформе
              </ButtonLink>
              <ButtonLink href="/login" variant="accent">
                Войти в сервис
              </ButtonLink>
            </div>
          </div>
        </Band>
      </main>
      <PublicFooter
        topicLinks={[
          { label: 'Материалы', href: '#' },
          { label: 'Технологии', href: '#' },
          { label: 'Рынки', href: '#' },
          { label: 'Люди', href: '#' },
        ]}
        editorialLinks={[
          { label: 'Еженедельный журнал', href: '/magazine' },
          { label: 'Как мы работаем с источниками', href: '#' },
          { label: 'Предложить материал', href: '#' },
        ]}
        platformLinks={[
          { label: 'О платформе', href: '/about' },
          { label: t('publicShell.signIn'), href: '/login' },
        ]}
        privacyHref="/privacy"
        termsHref="/terms"
        helpHref="/help"
      />
    </div>
  );
}

export const Home: Story = { render: () => <HomePage /> };
export const HomeMobile: Story = { render: () => <HomePage />, globals: { viewport: { value: 'mobile375', isRotated: false } } };

const icons = [HomeIcon, User, Building2, FolderKanban, ShoppingCart, TrendingUp, FileText, Sparkles];
const navItems: SidebarNavItem[] = locale.workspaceNav.map((label, index) => ({ id: String(index), label, href: '#', icon: icons[index] ?? HomeIcon, isCurrent: index === 0, dividerBefore: index === 3, attentionCount: index === 4 ? 1 : index === 5 ? 1 : undefined }));

function WorkspacePage() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={{ background: 'var(--color-canvas)', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <DemoStrip />
      <div style={{ display: 'flex', flex: 1 }}>
        <SidebarNav items={navItems} exitHref="/" brandHref="/" isCollapsed={collapsed} onCollapsedChange={setCollapsed} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <AppHeader onSearchPress={() => undefined} notificationCount={2} onNotificationsPress={() => undefined} account={{ name: 'Анна Примерова' }} menuItems={avatarMenuItems} />
          <main id="main" className={styles.workspaceMain}>
            <SectionHeader size="lg" headingLevel={1} title="Обзор" description="Закупки, продажи и ваши проекты" action={<Button icon={Plus} variant="accent">Создать</Button>} />
            <section aria-labelledby="decisions-title" className={styles.stack}>
              <SectionHeader size="sm" headingLevel={2} id="decisions-title" title="Нужно ваше решение" />
              <div className={cx('trustwork-enter-group', styles.stack)}>
                {decisions.map((item) => (
                  <DecisionCard key={item.title} {...item} meta={[...item.meta]} />
                ))}
              </div>
            </section>
            <div className={styles.mainAside}>
              <section aria-labelledby="projects-title" className={styles.stack} style={{ alignContent: 'start' }}>
                <SectionHeader size="sm" headingLevel={2} id="projects-title" title="Мои проекты" action={<Link variant="standalone" href="#">Все проекты</Link>} />
                <div className={cx('trustwork-enter-group', styles.stack)}>
                  <EntityCard layout="horizontal" kind="project" href="#" {...projects[0]} facts={[...projects[0].facts]} />
                  <EntityCard layout="horizontal" kind="project" href="#" {...projects[1]} facts={[...projects[1].facts]} />
                </div>
              </section>
              <Card title={t('events.upcoming')} headingLevel={2} id="events">
                <EventList label={t('events.upcoming')} items={events} />
              </Card>
            </div>
            <section aria-labelledby="industry-title" className={styles.stack}>
              <SectionHeader size="sm" headingLevel={2} id="industry-title" title="В отрасли" action={<Link variant="standalone" href="/">В отрасль</Link>} />
              <div className={cx('trustwork-enter-group', styles.cols3)}>
                {stories.slice(3, 6).map((item) => (
                  <StoryCard key={item.id} size="s" {...item} chips={[]} meta={[...item.meta]} />
                ))}
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}

export const Workspace: Story = { render: () => <WorkspacePage /> };

function ArticlePage() {
  return (
    <div style={{ background: 'var(--color-canvas)' }}>
      <PublicHeader hrefs={hrefs} currentIndex={2} brandHref="/" aboutHref="/about" onSearchPress={() => undefined} signInHref="/login" />
      <main id="main" className="trustwork-container" style={{ paddingTop: 'var(--space-10)', paddingBottom: 'var(--space-16)', display: 'grid', gap: 'var(--space-8)' }}>
        <header className={styles.articleHeader}>
          <Kicker>Разбор · Материалы</Kicker>
          <Heading level={1}>Как сравнивать предложения на фасадные панели: единицы, объёмы, замены</Heading>
          <Text styleAs="bodyLg" tone="muted">
            Единицы измерения, объёмы и замены — три причины, по которым два предложения нельзя сравнивать по одной цифре.
          </Text>
          <MetaRow items={['Редакция', '18 октября 2026', '6 мин']} />
        </header>
        <MediaFrame media={artworkFor('facade-window-grid')} ratio="21/9" loading="eager" sizes="1200px" />
        <div className={styles.articleBody}>
          <Prose>
            <p>Материалы задают тон проекту. Они определяют, как здание взаимодействует с человеком, городом и временем. Выбор материала — это всегда больше, чем техническая задача.</p>
            <p>За ним стоят эстетика, эксплуатация, экономика и, главное, люди, которые будут жить и работать в созданной среде.</p>
            <h2>Единицы измерения</h2>
            <p>Упаковка, погонный метр и квадратный метр — три разные единицы, и первое, что нужно сделать, — привести предложения к одной.</p>
            <h2>Объёмы и замены</h2>
            <p>Замена одной позиции на «аналог» без явной пометки делает предложение несопоставимым: такие строки должны быть выделены и объяснены.</p>
          </Prose>
          <aside className={styles.articleAside} aria-label="Дополнительно">
            <Quote cite="Инженер-технолог" source="Интервью редакции">
              Хороший выбор начинается с правильных вопросов.
            </Quote>
            <div className={styles.stack}>
              <SectionHeader size="sm" headingLevel={2} title="Ближайшие выпуски" />
              {archiveIssues.slice(0, 1).map((issue) => (
                <MagazineCover key={issue.issue} size="md" {...issue} href={`#issue-${issue.issue}`} />
              ))}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <DateTile date="2026-10-31" size="sm" tone="accent" />
                <Text styleAs="bodySm" tone="muted">
                  Следующий выпуск выходит 31 октября.
                </Text>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

export const Article: Story = { render: () => <ArticlePage /> };
