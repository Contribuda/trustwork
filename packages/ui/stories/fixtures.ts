import { Compass, CreditCard, HelpCircle, LogOut, Settings, Shield, User } from 'lucide-react';
import type { MenuItemDef } from '../src/components/Menu/Menu';
import { t } from '../src/i18n';

/** Avatar menu per the shell contract: «Помощь» directly before «Выйти» (consistent help). */
export const avatarMenuItems: MenuItemDef[] = [
  { id: 'me', label: t('shell.menu.myPage'), icon: User, href: '#' },
  { id: 'settings', label: t('shell.menu.accountSettings'), icon: Settings, href: '#' },
  { id: 'security', label: t('shell.menu.security'), icon: Shield, href: '#' },
  { id: 'billing', label: t('shell.menu.billing'), icon: CreditCard, href: '#' },
  { id: 'exit', label: t('publicExit'), icon: Compass, href: '#', separatorBefore: true },
  { id: 'help', label: t('shell.menu.help'), icon: HelpCircle, href: '#' },
  { id: 'signOut', label: t('shell.menu.signOut'), icon: LogOut, separatorBefore: true },
];
