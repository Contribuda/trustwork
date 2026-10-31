import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Breadcrumb } from '../src/components/Breadcrumb/Breadcrumb';
import { Pagination } from '../src/components/Pagination/Pagination';
import { Stepper } from '../src/components/Stepper/Stepper';

const meta = { title: 'Navigation/Breadcrumb, Pagination, Stepper', component: Breadcrumb } satisfies Meta<typeof Breadcrumb>;
export default meta;
type Story = StoryObj;

export const BreadcrumbStory: Story = {
  name: 'Breadcrumb',
  args: {
    items: [
      { id: 'projects', label: 'Проекты', href: '#' },
      { id: 'project', label: 'Пример проекта', href: '#' },
      { id: 'procurement', label: 'Закупка фасадных панелей' },
    ],
  },
};

function PaginationDemo({ pageCount, isLoading = false }: { pageCount: number; isLoading?: boolean }) {
  const [page, setPage] = useState(3);
  return <Pagination page={page} pageCount={pageCount} onPageChange={setPage} isLoading={isLoading} />;
}

export const PaginationButtons: Story = { render: () => <PaginationDemo pageCount={12} /> };
export const PaginationLinks: Story = { render: () => <Pagination page={1} pageCount={5} hrefFor={(p) => `?page=${p}`} /> };
export const PaginationLastPage: Story = { render: () => <Pagination page={5} pageCount={5} hrefFor={(p) => `?page=${p}`} /> };
export const PaginationLoading: Story = { render: () => <PaginationDemo pageCount={8} isLoading /> };

const steps = [
  { id: 'capabilities', label: 'Интересы' },
  { id: 'directions', label: 'Направления' },
  { id: 'regions', label: 'Регионы' },
];

export const StepperFirst: Story = { render: () => <Stepper steps={steps} current={1} /> };
export const StepperMiddle: Story = { render: () => <Stepper steps={steps} current={2} /> };
export const StepperLast: Story = { render: () => <Stepper steps={steps} current={3} /> };
export const StepperMobile: Story = { render: () => <Stepper steps={steps} current={2} />, globals: { viewport: { value: 'mobile320', isRotated: false } } };
