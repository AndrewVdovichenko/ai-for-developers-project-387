import '@mantine/core/styles.css';
import { MantineProvider } from '@mantine/core';
import type { Preview } from '@storybook/react-vite';
import { theme } from '../src/theme.js';
const preview: Preview = {
  globalTypes: { colorScheme: { toolbar: { title: 'Схема', items: ['light', 'dark'] } } },
  initialGlobals: { colorScheme: 'light' },
  decorators: [
    (Story, context) => (
      <MantineProvider
        theme={theme}
        forceColorScheme={context.globals.colorScheme === 'dark' ? 'dark' : 'light'}
      >
        <Story />
      </MantineProvider>
    ),
  ],
};
export default preview;
