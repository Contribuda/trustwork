import type { Meta, StoryObj } from '@storybook/react-vite';
import { Mail, Lock } from 'lucide-react';
import { PasswordField, TextArea, TextField } from '../src/components/TextField/TextField';
import { t } from '../src/i18n';

const meta = { title: 'Forms/TextField', component: TextField } satisfies Meta<typeof TextField>;
export default meta;
type Story = StoryObj;

const column = { display: 'grid', gap: 20, maxWidth: 480 } as const;

export const Default: Story = { args: { label: t('auth.email'), placeholder: t('auth.emailPlaceholder'), autoComplete: 'email', inputMode: 'email', icon: Mail } };
export const Required: Story = { args: { label: t('auth.email'), isRequired: true, description: 'Мы отправим письмо для подтверждения.' } };
export const Filled: Story = { args: { label: t('auth.email'), defaultValue: 'example@example.ru' } };
export const Error: Story = { args: { label: t('auth.email'), defaultValue: 'example', errorMessage: t('auth.error.emailFormat'), icon: Mail } };
export const Disabled: Story = { args: { label: t('auth.email'), defaultValue: 'example@example.ru', isDisabled: true } };
export const ReadOnly: Story = { args: { label: t('auth.email'), defaultValue: 'example@example.ru', isReadOnly: true } };

export const Password: Story = {
  render: () => (
    <div style={column}>
      <PasswordField label={t('auth.password')} placeholder={t('auth.passwordPlaceholder')} icon={Lock} />
      <PasswordField label={t('auth.password')} defaultValue="secret" errorMessage={t('auth.error.passwordRequired')} />
      <PasswordField label={t('auth.password')} defaultValue="secret" isDisabled />
    </div>
  ),
};

export const MultiLine: Story = {
  render: () => (
    <div style={column}>
      <TextArea label="Описание потребности" placeholder="Что нужно закупить, сроки, требования" maxLength={500} showCounter description="Укажите объём и единицы измерения." />
      <TextArea label="Комментарий" defaultValue="Текст с ошибкой" errorMessage="Комментарий слишком короткий" rows={3} />
      <TextArea label="Комментарий" defaultValue="Только чтение" isReadOnly rows={2} />
    </div>
  ),
};
