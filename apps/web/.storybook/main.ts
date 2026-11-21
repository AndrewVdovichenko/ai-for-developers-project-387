import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { StorybookConfig } from '@storybook/react-vite';
const require = createRequire(import.meta.url);
const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.tsx'],
  framework: dirname(require.resolve('@storybook/react-vite/package.json')),
  core: { disableTelemetry: true },
};
export default config;
