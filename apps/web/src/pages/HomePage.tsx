import { AppShell, Button, Container, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router';
import { ShellHeader } from '../ShellHeader';

export function HomePage() {
  return (
    <AppShell header={{ height: 60 }} padding={0}>
      <ShellHeader />
      <AppShell.Main>
        <Container size="sm" py="xl">
          <Stack gap="md">
            <Title order={1}>Запись на&nbsp;встречи по&nbsp;ссылке</Title>
            <Text c="dimmed" size="lg">
              Владелец публикует расписание&nbsp;— гость выбирает день и&nbsp;слот, вводит имя
              и&nbsp;email и&nbsp;получает запись в&nbsp;календаре владельца. Регистрация гостю
              не&nbsp;нужна.
            </Text>
            <Button component={Link} to="/event-types" size="lg" w="fit-content">
              Записаться на&nbsp;встречу
            </Button>
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
