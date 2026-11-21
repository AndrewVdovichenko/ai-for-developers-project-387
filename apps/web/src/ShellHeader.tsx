import { AppShell, Group, Title } from '@mantine/core';
import { Link } from 'react-router';

export function ShellHeader() {
  return (
    <AppShell.Header>
      <Group h="100%" px="md">
        <Link to="/" style={{ textDecoration: 'none' }}>
          <Title order={3} c="teal">
            Календарь&nbsp;звонков
          </Title>
        </Link>
        <Link to="/owner/event-types">Вход Владельца</Link>
      </Group>
    </AppShell.Header>
  );
}
