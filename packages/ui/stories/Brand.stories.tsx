import type { Meta, StoryObj } from '@storybook/react-vite';
import { Brand } from '../src/components/Brand/Brand';

const meta = {
  title: 'Brand/Logo',
  component: Brand,
  parameters: { docs: { description: { component: 'Canonical lockup: three blue squares (L arrangement, top-left slot empty) plus the black stacked wordmark outlined from Golos Text Bold. See docs/design/system/logo.md.' } } },
} satisfies Meta<typeof Brand>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Full: Story = { args: { height: 48 } };
export const AsLink: Story = { args: { height: 40, href: '/' } };
export const Mark: Story = { args: { variant: 'mark', height: 40 } };
export const Mono: Story = { args: { tone: 'mono', height: 48 } };
export const Inverse: Story = {
  args: { tone: 'inverse', height: 48 },
  render: (args) => (
    <div style={{ background: 'var(--color-accent-strong)', padding: 24, display: 'inline-block', borderRadius: 12 }}>
      <Brand {...args} />
    </div>
  ),
};
export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
      <Brand height={24} />
      <Brand height={32} />
      <Brand height={48} />
      <Brand height={64} />
      <Brand variant="mark" height={24} />
      <Brand variant="mark" height={56} />
    </div>
  ),
};
