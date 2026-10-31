import type { Preview } from '@storybook/react-vite';
import { UiProvider } from '../src/components/UiProvider/UiProvider';
import '../tokens/tokens.css';
import '../fonts/fonts.css';
import '../src/styles/base.css';

if (typeof document !== 'undefined') document.documentElement.lang = 'ru';

const preview: Preview = {
  parameters: {
    layout: 'padded',
    backgrounds: { options: { canvas: { name: 'canvas', value: '#f6f5f2' }, surface: { name: 'surface', value: '#ffffff' } } },
    a11y: {
      // Fail the story in the Storybook UI on any WCAG 2.x A/AA violation; the Playwright run enforces it in CI.
      test: 'error',
      config: { rules: [{ id: 'region', enabled: false }] },
      options: { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } },
    },
    viewport: {
      options: {
        mobile320: { name: 'Mobile 320', styles: { width: '320px', height: '640px' }, type: 'mobile' },
        mobile375: { name: 'Mobile 375', styles: { width: '375px', height: '812px' }, type: 'mobile' },
        tablet: { name: 'Tablet 768', styles: { width: '768px', height: '1024px' }, type: 'tablet' },
        desktop: { name: 'Desktop 1280', styles: { width: '1280px', height: '800px' }, type: 'desktop' },
      },
    },
  },
  initialGlobals: { backgrounds: { value: 'canvas' } },
  decorators: [
    (Story) => (
      <UiProvider>
        <Story />
      </UiProvider>
    ),
  ],
};

export default preview;
