import { Alert, Button, Container, Loader, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { EventType } from '@calendar/api-client';
import { listTypes } from '../event-types-api';
import { EventTypeCard } from '../EventTypeCard';

export function EventTypesPage() {
  const [items, setItems] = useState<EventType[]>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void listTypes()
      .then((result) => {
        if (!active) return;
        if (result.data) setItems(result.data.items);
        else setError('Не удалось загрузить типы встреч');
      })
      .catch(() => {
        if (active) setError('Не удалось загрузить типы встреч');
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  return (
    <Container size="sm" py="xl">
      <Stack>
        <Title order={1}>Типы встречи</Title>
        {error ? (
          <>
            <Alert color="red" role="alert">
              {error}
            </Alert>
            <Button
              onClick={() => {
                setItems(undefined);
                setError('');
                setAttempt((value) => value + 1);
              }}
            >
              Повторить
            </Button>
          </>
        ) : items === undefined ? (
          <Loader aria-label="Загружаем типы встреч" />
        ) : items.length === 0 ? (
          <Text>Пока нет типов встреч для записи</Text>
        ) : (
          items.map((type) => <EventTypeCard key={type.id} type={type} />)
        )}
        <Text component={Link} to="/">
          На&nbsp;главную
        </Text>
      </Stack>
    </Container>
  );
}
