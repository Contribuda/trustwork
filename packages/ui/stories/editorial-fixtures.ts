import { coverFor, artwork, photo } from '../src/media/index';

/**
 * Synthetic editorial fixtures for stories. Names are deliberately generic («Фасад-Пример», «Образец-Строй»);
 * nothing here describes a real company, person, rating or traffic (operating agreement).
 */

export const stories = [
  {
    id: 'facades-standard',
    kicker: 'Новость',
    chips: ['Материалы', 'Регулирование'],
    title: 'Новый стандарт на вентилируемые фасады вступит в силу весной',
    dek: 'Обновлённый стандарт уточняет требования к крепежу и испытаниям; производителям дадут переходный период.',
    meta: ['Редакция', '21 октября 2026', '2 мин'],
    href: '#story-1',
    media: photo('glass-steel-facade'),
  },
  {
    id: 'compare-panels',
    kicker: 'Разбор',
    chips: ['Материалы', 'Рынки'],
    title: 'Как сравнивать предложения на фасадные панели: единицы, объёмы, замены',
    dek: 'Единицы измерения, объёмы и замены — три причины, по которым два предложения нельзя сравнивать по одной цифре.',
    meta: ['Редакция', '18 октября 2026', '6 мин'],
    href: '#story-2',
    media: photo('facade-window-grid'),
  },
  {
    id: 'insulation-protocols',
    kicker: 'Интервью',
    chips: ['Технологии', 'Люди'],
    title: 'Интервью: как читать протоколы испытаний утеплителя',
    dek: 'Инженер-технолог о том, какие строки протокола читать первыми и что чаще всего путают.',
    meta: ['Редакция', '14 октября 2026', '5 мин'],
    href: '#story-3',
    media: artwork('mineral-wool'),
  },
  {
    id: 'acceptance-stages',
    kicker: 'Опыт',
    chips: ['Проекты'],
    title: 'Опыт: приёмка фасада по этапам, а не в конце',
    dek: 'Личный опыт руководителя проекта: как поэтапная приёмка снимает споры в конце объекта.',
    meta: ['Анна Примерова', '10 октября 2026', '4 мин'],
    href: '#story-4',
    media: photo('house-scaffolding'),
  },
  {
    id: 'supplier-checklist',
    kicker: 'Практика',
    chips: ['Рынки'],
    title: 'Практика: чек-лист запроса поставщику',
    dek: 'Пять пунктов, без которых поставщику не дать сопоставимых предложений.',
    meta: ['Редакция', '5 октября 2026', '3 мин'],
    href: '#story-5',
    media: artwork('blueprint-lines'),
  },
  {
    id: 'concrete-logistics',
    kicker: 'Обзор',
    chips: ['Рынки', 'Материалы'],
    title: 'Обзор: как менялась логистика бетона в регионе за год',
    dek: 'Наблюдения компании о плече доставки и сезонности спроса.',
    meta: ['Бетон Образцовый', '30 сентября 2026', '4 мин'],
    href: '#story-6',
    media: photo('concrete-wall'),
  },
] as const;

export const newsItems = [
  { kicker: 'Материалы', title: 'Фасады зимой: что можно монтировать при минусе', meta: ['Редакция', '26 октября 2026'], href: '#news-1' },
  { kicker: 'Технологии', title: 'Итоги конференции по информационному моделированию: что обсуждали подрядчики', meta: ['Редакция', '27 октября 2026'], href: '#news-2' },
  { kicker: 'Рынки', title: 'Завод в Татарстане запустил линию минераловатных плит', meta: ['Редакция', '25 октября 2026'], href: '#news-3' },
  { kicker: 'Регулирование', title: 'Новый стандарт на вентилируемые фасады вступит в силу весной', meta: ['Редакция', '21 октября 2026'], href: '#news-4' },
] as const;

export const companies = [
  { name: 'Фасад-Пример', description: 'Вентилируемые фасады и остекление', status: 'claimed' as const, facts: [{ label: 'Регион', value: 'Ташкент' }, { label: 'Проекты', value: '12' }, { label: 'Публикации', value: '8' }], meta: ['Обновлено 25 октября 2026'] },
  { name: 'Образец-Строй', description: 'Проектирование и генподряд', status: 'sourced' as const, facts: [{ label: 'Регион', value: 'Казань' }, { label: 'Проекты', value: '4' }, { label: 'Публикации', value: '2' }], meta: ['Из открытых источников'] },
  { name: 'Бетон Образцовый', description: 'Товарный бетон и растворы', status: 'verified' as const, facts: [{ label: 'Регион', value: 'Тверь' }, { label: 'Проекты', value: '21' }, { label: 'Публикации', value: '5' }], meta: ['Подтверждено 12 октября 2026'] },
] as const;

export const people = [
  { name: 'Анна Примерова', description: 'Руководитель проектов, «Фасад-Пример»', facts: [{ label: 'Проекты', value: '7' }, { label: 'Публикации', value: '3' }] },
  { name: 'Пётр Образцов', description: 'Частный заказчик', facts: [{ label: 'Проекты', value: '1' }] },
] as const;

export const projects = [
  { name: 'Школа на набережной: фасад и остекление', description: 'Реализуется · следующий этап: фасадные панели', status: 'claimed' as const, facts: [{ label: 'Этапов', value: '6' }, { label: 'Участников', value: '4' }] },
  { name: 'Павильон в парке у завода', description: 'Завершён', status: 'claimed' as const, facts: [{ label: 'Этапов', value: '4' }, { label: 'Участников', value: '2' }] },
] as const;

export const magazineIssue = {
  issue: 12,
  dateRange: '18 — 24 октября 2026',
  title: 'Фасады перед зимой',
  topics: ['Монтаж при минусе', 'Протоколы испытаний', 'Приёмка по этапам'],
  media: photo('corrugated-building'),
  summary: 'Что ещё можно сделать на фасаде до морозов, как читать протоколы и почему приёмка по этапам снимает споры.',
};

export const archiveIssues = [
  { issue: 11, dateRange: '11 — 17 октября 2026', title: 'Осень на стройке', media: coverFor('magazine', 11, { prefer: 'photo' }) },
  { issue: 10, dateRange: '4 — 10 октября 2026', title: 'Сталь и дерево', media: coverFor('magazine', 10, { prefer: 'photo' }) },
  { issue: 9, dateRange: '27 сентября — 3 октября 2026', title: 'Чертёж как договор', media: artwork('blueprint-lines') },
] as const;

export const decisions = [
  { tone: 'decision' as const, title: 'Сравнение готово: стальные балки', summary: 'Закупка · 3 предложения на версию 2', meta: ['Срок: 2 ноября 2026'], action: { label: 'Сравнить', href: '#decision-1' } },
  { tone: 'review' as const, title: 'Заказчик выбрал версию 3: фасад загородного дома', summary: 'Продажи · принять или отклонить заказ', meta: ['Срок: 8 ноября 2026'], action: { label: 'Открыть', href: '#decision-2' } },
  { tone: 'assistant' as const, title: 'Помощник просит одобрить заказ подсистемы', summary: 'Поручение · условия изменились после запроса', meta: ['Срок: 29 октября 2026'], action: { label: 'Проверить', href: '#decision-3' } },
] as const;

export const events = [
  { id: 'e1', date: '2026-10-30', title: 'Срок действия предложения для УК «Образец»', context: 'Продажи', href: '#event-1' },
  { id: 'e2', date: '2026-10-31', title: 'Выход выпуска журнала № 13', context: 'Журнал', href: '#event-2' },
  { id: 'e3', date: '2026-11-02', title: 'Крайний срок ответов: стальные балки', context: 'Закупки', href: '#event-3', tone: 'warning' as const },
  { id: 'e4', date: '2026-11-10', title: 'Этап «Утепление стен» в проекте дома', context: 'Загородный дом', href: '#event-4' },
] as const;

export const personas = [
  { id: 'guest', label: 'Гость' },
  { id: 'reader', label: 'Читатель и автор без компании' },
  { id: 'employee', label: 'Сотрудник компании: закупает и продаёт' },
  { id: 'owner', label: 'Владелец личного проекта' },
] as const;
