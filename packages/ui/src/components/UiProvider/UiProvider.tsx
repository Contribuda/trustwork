import type { ReactNode } from 'react';
import { I18nProvider } from 'react-aria-components';
import { intlTag } from '../../i18n';
import { ToastProvider, ToastRegion } from '../Toast/Toast';

export type UiProviderProps = { children: ReactNode; /** Render the toast live region (once per document). */ withToastRegion?: boolean | undefined };

/**
 * Wrap the application once: pins React Aria's locale to the active one (its built-in strings and
 * date/number formatting are otherwise taken from the browser, and from en-US during server rendering)
 * and provides the toast queue. The application's locale provider must sit above this component.
 */
export function UiProvider({ children, withToastRegion = true }: UiProviderProps) {
  return (
    <I18nProvider locale={intlTag()}>
      <ToastProvider>
        {children}
        {withToastRegion ? <ToastRegion /> : null}
      </ToastProvider>
    </I18nProvider>
  );
}
