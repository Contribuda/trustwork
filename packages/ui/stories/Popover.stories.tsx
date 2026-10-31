import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bell, Settings } from 'lucide-react';
import { Button, IconButton } from '../src/components/Button/Button';
import { AvatarButton } from '../src/components/Avatar/Avatar';
import { Menu, MenuTrigger } from '../src/components/Menu/Menu';
import { Popover, PopoverTrigger } from '../src/components/Popover/Popover';
import { Tooltip, TooltipTrigger } from '../src/components/Tooltip/Tooltip';
import { t } from '../src/i18n';
import { avatarMenuItems } from './fixtures';

const meta = { title: 'Overlays/Popover, Menu, Tooltip', component: Popover } satisfies Meta<typeof Popover>;
export default meta;
type Story = StoryObj;

export const PopoverClosed: Story = {
  render: () => (
    <PopoverTrigger>
      <IconButton icon={Bell} aria-label={t('shell.notifications')} />
      <Popover title={t('shell.notifications')}>
        <p>{t('shell.noNotifications')}</p>
      </Popover>
    </PopoverTrigger>
  ),
};

export const PopoverOpen: Story = {
  render: () => (
    <PopoverTrigger defaultOpen>
      <IconButton icon={Bell} aria-label={t('shell.notifications')} />
      <Popover title={t('shell.notifications')} width={320}>
        <p>{t('shell.noNotifications')}</p>
        <p style={{ marginTop: 12 }}>
          <a href="#">{t('shell.allNotifications')}</a>
        </p>
      </Popover>
    </PopoverTrigger>
  ),
};



export const AvatarMenu: Story = {
  render: () => (
    <MenuTrigger>
      <AvatarButton name="Имя Фамилия" aria-label={t('shell.account')} />
      <Menu items={avatarMenuItems} header="Имя Фамилия" aria-label={t('shell.account')} />
    </MenuTrigger>
  ),
};

export const AvatarMenuOpen: Story = {
  render: () => (
    <MenuTrigger defaultOpen>
      <AvatarButton name="Имя Фамилия" aria-label={t('shell.account')} />
      <Menu items={avatarMenuItems} header="Имя Фамилия" aria-label={t('shell.account')} />
    </MenuTrigger>
  ),
};

export const MenuWithDisabledAndDestructive: Story = {
  render: () => (
    <MenuTrigger defaultOpen>
      <Button variant="secondary">Действия со строкой</Button>
      <Menu
        aria-label="Действия со строкой"
        items={[
          { id: 'open', label: 'Открыть' },
          { id: 'edit', label: 'Изменить', isDisabled: true },
          { id: 'delete', label: 'Удалить', isDestructive: true, separatorBefore: true },
        ]}
      />
    </MenuTrigger>
  ),
};

export const TooltipStory: Story = {
  name: 'Tooltip',
  render: () => (
    <div style={{ display: 'flex', gap: 16 }}>
      <TooltipTrigger>
        <IconButton icon={Bell} aria-label={t('shell.notifications')} />
        <Tooltip>{t('shell.notifications')}</Tooltip>
      </TooltipTrigger>
      <TooltipTrigger isOpen>
        <IconButton icon={Settings} aria-label={t('shell.menu.accountSettings')} />
        <Tooltip placement="bottom">{t('shell.menu.accountSettings')}</Tooltip>
      </TooltipTrigger>
    </div>
  ),
};
