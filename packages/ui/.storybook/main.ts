import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../stories/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  core: { disableTelemetry: true },
  staticDirs: [{ from: '../fonts', to: '/fonts' }, { from: '../brand', to: '/brand' }, { from: '../media', to: '/media' }],
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    // Workspace package sources are consumed directly; no React plugin is needed because Vite's esbuild
    // handles the automatic JSX runtime declared in tsconfig.
    // Class names are exported as written (hyphenated keys such as `tone-success` are accessed with bracket syntax), matching Next.js CSS Modules.
    css: { ...viteConfig.css, modules: { generateScopedName: 'trustwork-[name]-[local]-[hash:base64:4]' } },
  }),
};

export default config;
