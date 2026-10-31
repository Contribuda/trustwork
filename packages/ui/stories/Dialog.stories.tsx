import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Button } from '../src/components/Button/Button';
import { ConfirmDialog, Dialog } from '../src/components/Dialog/Dialog';
import { TextField } from '../src/components/TextField/TextField';
import { t } from '../src/i18n';

const meta = { title: 'Overlays/Dialog', component: Dialog } satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj;

function Demo({ initialOpen = false, size, loading = false }: { initialOpen?: boolean; size?: 'sm' | 'md' | 'lg' | 'sheet'; loading?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <Button onPress={() => setOpen(true)}>Открыть окно</Button>
      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        title="Пригласить поставщиков"
        description="Приглашение получат только компании с подтверждённым доступом."
        size={size}
        isLoading={loading}
        actions={
          <>
            <Button variant="secondary" onPress={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onPress={() => setOpen(false)}>Пригласить</Button>
          </>
        }
      >
        <TextField label="Электронная почта поставщика" inputMode="email" autoFocus />
      </Dialog>
    </>
  );
}

export const Closed: Story = { render: () => <Demo /> };
export const Open: Story = { render: () => <Demo initialOpen /> };
export const Loading: Story = { render: () => <Demo initialOpen loading /> };
export const Large: Story = { render: () => <Demo initialOpen size="lg" /> };
export const Sheet: Story = { render: () => <Demo initialOpen size="sheet" />, globals: { viewport: { value: 'mobile375', isRotated: false } } };

function ConfirmDemo({ destructive = false }: { destructive?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button variant={destructive ? 'danger' : 'primary'} onPress={() => setOpen(true)}>
        {destructive ? 'Отозвать поручение' : 'Опубликовать'}
      </Button>
      <ConfirmDialog
        isOpen={open}
        onOpenChange={setOpen}
        title={destructive ? 'Отозвать поручение?' : 'Опубликовать потребность?'}
        confirmLabel={destructive ? 'Отозвать' : 'Опубликовать'}
        isDestructive={destructive}
        onConfirm={() => setOpen(false)}
      >
        {destructive ? 'Будущие действия будут заблокированы. Уже совершённые внешние действия отменить нельзя.' : 'После публикации поставщики смогут присылать предложения.'}
      </ConfirmDialog>
    </>
  );
}

export const Confirm: Story = { render: () => <ConfirmDemo /> };
export const ConfirmDestructive: Story = { render: () => <ConfirmDemo destructive /> };
