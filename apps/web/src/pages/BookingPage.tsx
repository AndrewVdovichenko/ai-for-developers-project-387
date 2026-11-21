import { Alert, Button, Container, Loader, Stack, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { EventType } from '@calendar/api-client';
import { readType } from '../event-types-api';
import { BookingCalendar } from '../BookingCalendar';
import { EventTypeCard } from '../EventTypeCard';

export function BookingPage() {
  const { id = '' } = useParams();
  return <BookingDetails key={id} id={id} />;
}

function BookingDetails({ id }: { id: string }) {
  const [type, setType] = useState<EventType>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void readType(id)
      .then((result) => {
        if (!active) return;
        if (result.data) setType(result.data);
        else
          setError(
            result.response?.status === 404
              ? 'Тип встречи не найден'
              : 'Не удалось загрузить тип встречи',
          );
      })
      .catch(() => {
        if (active) setError('Не удалось загрузить тип встречи');
      });
    return () => {
      active = false;
    };
  }, [id, attempt]);
  return (
    <Container size="sm" py="xl">
      <Stack>
        <Title order={1}>Страница записи</Title>
        {error ? (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        ) : type ? (
          <>
            <EventTypeCard type={type} />
            <BookingCalendar id={id} />
          </>
        ) : (
          <Loader aria-label="Загружаем тип встречи" />
        )}
        {error && error !== 'Тип встречи не найден' && (
          <Button
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            Повторить
          </Button>
        )}
        <Button component={Link} to="/event-types" variant="subtle">
          В&nbsp;каталог
        </Button>
        <Button component={Link} to="/" variant="subtle">
          На&nbsp;главную
        </Button>
      </Stack>
    </Container>
  );
}
