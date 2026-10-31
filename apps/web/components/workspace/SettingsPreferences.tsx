'use client';

import { useState } from 'react';
import { Checkbox, CheckboxGroup, Switch } from '@trustwork/ui';
import { t } from '@/app/_lib/i18n';

/** Preferences form (demo: local state only). Unpinning moves a section under «Ещё»; it is never deleted. */
export function SettingsPreferences({ pinned }: { pinned: { procurement: boolean; sales: boolean } }) {
  const [procurement, setProcurement] = useState(pinned.procurement);
  const [sales, setSales] = useState(pinned.sales);
  const [notify, setNotify] = useState<string[]>(['decisions', 'runs', 'publications', 'magazine']);
  const [focusLast, setFocusLast] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-3)' }}>
        <legend className="story__title">{t('settings.preferences.sections')}</legend>
        <Switch isSelected={procurement} onChange={setProcurement}>
          {t('settings.preferences.pinProcurement')}
        </Switch>
        <Switch isSelected={sales} onChange={setSales}>
          {t('settings.preferences.pinSales')}
        </Switch>
        <p className="sr-note">{t('settings.preferences.pinNote')}</p>
      </fieldset>
      <CheckboxGroup label={t('settings.preferences.notifications')} value={notify} onChange={setNotify}>
        {(['decisions', 'runs', 'publications', 'magazine'] as const).map((key) => (
          <Checkbox key={key} value={key}>
            {t(`settings.preferences.notify.${key}`)}
          </Checkbox>
        ))}
      </CheckboxGroup>
      <Switch isSelected={focusLast} onChange={setFocusLast}>
        {t('settings.preferences.assistantFocus')}
      </Switch>
      <p className="sr-note">{t('settings.preferences.demoNote')}</p>
    </div>
  );
}
