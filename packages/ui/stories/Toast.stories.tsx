import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { Button } from '../src/components/Button/Button';
import { ToastRegion, useToast } from '../src/components/Toast/Toast';
import { t } from '../src/i18n';

const meta = { title: 'Overlays/Toast', component: ToastRegion } satisfies Meta<typeof ToastRegion>;
export default meta;
type Story = StoryObj;

function Buttons() {
  const { add } = useToast();
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <Button variant="secondary" onPress={() => add({ tone: 'info', title: 'Черновик сохранён' })}>
        Информация
      </Button>
      <Button variant="secondary" onPress={() => add({ tone: 'success', title: t('common.saved'), description: 'Изменения вступили в силу.' })}>
        Успех
      </Button>
      <Button variant="secondary" onPress={() => add({ tone: 'warning', title: t('common.offline'), description: 'Действие повторится при восстановлении связи.' })}>
        Предупреждение
      </Button>
      <Button variant="secondary" onPress={() => add({ tone: 'error', title: 'Не удалось сохранить', action: { label: t('common.retry'), onPress: () => undefined } })}>
        Ошибка
      </Button>
    </div>
  );
}

function Preloaded() {
  const { add, toasts } = useToast();
  useEffect(() => {
    if (toasts.length) return;
    add({ tone: 'success', title: t('common.saved'), description: 'Изменения вступили в силу.' });
    add({ tone: 'error', title: 'Не удалось сохранить', description: 'Проверьте соединение.', action: { label: t('common.retry'), onPress: () => undefined } });
  }, []);
  return <Buttons />;
}

export const Trigger: Story = { render: () => <Buttons /> };
export const Visible: Story = { render: () => <Preloaded /> };
