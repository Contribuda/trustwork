import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bell, ExternalLink, Plus, Search, Trash2 } from 'lucide-react';
import { Button, IconButton, IconLink } from '../src/components/Button/Button';
import { Icon } from '../src/components/Icon/Icon';
import { Spinner } from '../src/components/Spinner/Spinner';

const meta = { title: 'Primitives/Button', component: Button } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj;

const row = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' } as const;

export const Variants: Story = {
  render: () => (
    <div style={row}>
      <Button>Сохранить</Button>
      <Button variant="accent">Сравнить предложения</Button>
      <Button variant="secondary">Отмена</Button>
      <Button variant="ghost">Показать ещё</Button>
      <Button variant="danger" icon={Trash2}>
        Удалить
      </Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div style={row}>
      <Button size="sm">Маленькая</Button>
      <Button size="md">Обычная</Button>
      <Button size="lg">Большая</Button>
      <Button icon={Plus}>Создать</Button>
      <Button fullWidth>На всю ширину</Button>
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div style={row}>
      <Button isDisabled>Недоступно</Button>
      <Button isLoading pendingLabel="Входим…">
        Войти
      </Button>
      <Button variant="secondary" isLoading>
        Сохранить
      </Button>
      <Button autoFocus>С фокусом</Button>
    </div>
  ),
};

export const IconOnly: Story = {
  render: () => (
    <div style={row}>
      <IconButton icon={Search} aria-label="Поиск" />
      <IconButton icon={Bell} aria-label="Уведомления" variant="secondary" />
      <IconButton icon={Plus} aria-label="Создать" variant="accent" />
      <IconButton icon={Trash2} aria-label="Удалить" variant="danger" size="sm" />
      <IconButton icon={Search} aria-label="Поиск" size="lg" />
      <IconButton icon={Search} aria-label="Поиск" isLoading />
      <IconButton icon={Bell} aria-label="Показать пароль" isPressed />
      <IconLink icon={ExternalLink} aria-label="Открыть страницу" href="#" />
    </div>
  ),
};

export const IconsAndSpinner: Story = {
  render: () => (
    <div style={row}>
      <Icon icon={Search} size={16} />
      <Icon icon={Search} size={20} />
      <Icon icon={Search} size={24} label="Поиск" />
      <Spinner size={16} />
      <Spinner size={24} label="Загружаем список" />
    </div>
  ),
};
