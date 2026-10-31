import type { Meta, StoryObj } from '@storybook/react-vite';
import { Checkbox, CheckboxGroup, Radio, RadioGroup, Switch } from '../src/components/Choice/Choice';

const meta = { title: 'Forms/Checkbox, Radio, Switch', component: Checkbox } satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj;

export const Checkboxes: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 4, maxWidth: 480 }}>
      <Checkbox>Не выбрано</Checkbox>
      <Checkbox defaultSelected>Выбрано</Checkbox>
      <Checkbox isIndeterminate>Выбрано частично</Checkbox>
      <Checkbox isDisabled>Недоступно</Checkbox>
      <Checkbox isDisabled defaultSelected>
        Недоступно и выбрано
      </Checkbox>
      <Checkbox isInvalid>С ошибкой</Checkbox>
      <Checkbox description="Можно изменить позже в настройках.">С описанием</Checkbox>
    </div>
  ),
};

export const CheckboxGroupStory: Story = {
  name: 'Checkbox group',
  render: () => (
    <div style={{ display: 'grid', gap: 24, maxWidth: 480 }}>
      <CheckboxGroup label="Что искать" description="Можно выбрать несколько вариантов." defaultValue={['company']}>
        <Checkbox value="company">Компании</Checkbox>
        <Checkbox value="person">Люди</Checkbox>
        <Checkbox value="project">Проекты</Checkbox>
      </CheckboxGroup>
      <CheckboxGroup label="Что искать" errorMessage="Выберите хотя бы один вариант" orientation="horizontal">
        <Checkbox value="company">Компании</Checkbox>
        <Checkbox value="person">Люди</Checkbox>
      </CheckboxGroup>
    </div>
  ),
};

export const Radios: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, maxWidth: 480 }}>
      <RadioGroup label="Период данных" defaultValue="current">
        <Radio value="current">Текущие данные</Radio>
        <Radio value="asOf" description="Показать версию на выбранную дату">
          Версия на дату
        </Radio>
        <Radio value="off" isDisabled>
          Недоступно
        </Radio>
      </RadioGroup>
      <RadioGroup label="Согласование" orientation="horizontal" errorMessage="Выберите вариант">
        <Radio value="none">Не требуется</Radio>
        <Radio value="each">Каждое действие</Radio>
      </RadioGroup>
      <RadioGroup label="Недоступная группа" isDisabled defaultValue="a">
        <Radio value="a">Вариант А</Radio>
        <Radio value="b">Вариант Б</Radio>
      </RadioGroup>
    </div>
  ),
};

export const Switches: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 4, maxWidth: 480 }}>
      <Switch>Уведомлять о новых предложениях</Switch>
      <Switch defaultSelected>Показывать «Закупки» в меню</Switch>
      <Switch isDisabled>Недоступно</Switch>
      <Switch isLoading defaultSelected>
        Сохраняем…
      </Switch>
    </div>
  ),
};
