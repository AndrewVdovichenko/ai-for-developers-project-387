import { createTheme } from '@mantine/core';

// Цветовые роли зафиксированы в docs/adr/0002: primary — teal,
// success — green, error — red, warning — yellow, нейтральные — gray.
// Тёмная схема включена через defaultColorScheme="auto" у MantineProvider.
export const theme = createTheme({
  primaryColor: 'teal',
});
