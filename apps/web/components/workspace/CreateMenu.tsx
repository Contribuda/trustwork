'use client';

import { Button, Icon, Menu, MenuTrigger } from '@trustwork/ui';
import { ChevronDown, Plus } from 'lucide-react';
import { t } from '@/app/_lib/i18n';

/** Single menu button «Создать» with a chevron (A3 recommended default, not a split button); items depend on grants. */
export function CreateMenu({ items }: { items: Array<{ id: 'need' | 'quote' | 'project' | 'publication'; href: string }> }) {
  return (
    <MenuTrigger>
      <Button icon={Plus} variant="accent">
        {t('overview.create')}
        <Icon icon={ChevronDown} size={16} />
      </Button>
      <Menu aria-label={t('overview.create')} items={items.map((item) => ({ id: item.id, label: t(`overview.createItems.${item.id}`), href: item.href }))} />
    </MenuTrigger>
  );
}
