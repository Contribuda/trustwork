import type { Meta, StoryObj } from '@storybook/react-vite';
import { Avatar, AvatarButton } from '../src/components/Avatar/Avatar';
import { t } from '../src/i18n';

const meta = { title: 'Primitives/Avatar', component: Avatar } satisfies Meta<typeof Avatar>;
export default meta;
type Story = StoryObj;

const svg = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1e2a44"/><circle cx="32" cy="24" r="12" fill="#e6eefc"/><rect x="12" y="42" width="40" height="22" rx="11" fill="#e6eefc"/></svg>')}`;

export const Initials: Story = { args: { name: 'Имя Фамилия' } };
export const Image: Story = { args: { name: 'Имя Фамилия', src: svg } };
export const Decorative: Story = {
  render: () => (
    <p style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Avatar name="Имя Фамилия" decorative size={32} /> Имя Фамилия
    </p>
  ),
};
export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
      {([24, 32, 40, 48, 64, 96] as const).map((size) => (
        <Avatar key={size} name="Имя Фамилия" size={size} />
      ))}
    </div>
  ),
};
export const AccountButton: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12 }}>
      <AvatarButton name="Имя Фамилия" aria-label={t('shell.account')} />
      <AvatarButton name="Имя Фамилия" src={svg} aria-label={t('shell.account')} />
    </div>
  ),
};
