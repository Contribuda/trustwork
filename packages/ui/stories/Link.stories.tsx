import type { Meta, StoryObj } from '@storybook/react-vite';
import { Link } from '../src/components/Link/Link';

const meta = { title: 'Primitives/Link', component: Link } satisfies Meta<typeof Link>;
export default meta;
type Story = StoryObj;

export const Inline: Story = {
  render: () => (
    <p>
      Публикации с состоянием «исправлено» показывают <Link href="#">пометку об исправлении</Link> рядом с заголовком.
    </p>
  ),
};
export const Standalone: Story = { args: { variant: 'standalone', href: '#', children: 'Все новости' } };
export const External: Story = { args: { variant: 'external', href: 'https://example.com/', children: 'Сайт компании' } };
export const Nav: Story = { args: { variant: 'nav', href: '#', children: 'Компании' } };
export const Disabled: Story = { args: { variant: 'standalone', href: '#', isDisabled: true, children: 'Недоступная ссылка' } };
