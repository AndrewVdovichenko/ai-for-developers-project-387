import { Alert, Button, Container, Group, Loader, Stack, Title, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { OwnerBookings } from './OwnerBookings';
import { OwnerEventTypes } from './OwnerEventTypes';
import { OwnerAvailability } from './OwnerAvailability';
import { readSession, signOut } from '../owner-api';

const sections = [
  { path: '/owner/event-types', title: 'Типы встречи' },
  { path: '/owner/availability', title: 'Расписание' },
  { path: '/owner/bookings', title: 'Предстоящие встречи' },
];

export function OwnerPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const check = () => {
      void readSession()
        .then((result) => {
          if (!active) return;
          if (!result.data) setError('Не удалось проверить доступ. Повторите попытку.');
          else if (!result.data.authenticated)
            void navigate(
              `/owner/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`,
              { replace: true },
            );
          else {
            setAuthenticated(true);
            setError('');
          }
        })
        .catch(() => {
          if (active) setError('Нет соединения. Повторите попытку.');
        });
    };
    check();
    window.addEventListener('focus', check);
    return () => {
      active = false;
      window.removeEventListener('focus', check);
    };
  }, [location.pathname, location.search, navigate, attempt]);

  return (
    <Container size="md" py="xl">
      <Stack>
        <Title order={1}>
          {sections.find((section) => section.path === location.pathname)?.title}
        </Title>
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        {!authenticated ? (
          error ? (
            <Button onClick={() => setAttempt((value) => value + 1)}>Повторить</Button>
          ) : (
            <Loader aria-label="Проверяем сессию" />
          )
        ) : (
          <>
            <Group>
              {sections.map((section) => (
                <Text component={Link} to={section.path} key={section.path}>
                  {section.title}
                </Text>
              ))}
            </Group>
            {location.pathname === '/owner/event-types' && <OwnerEventTypes />}
            {location.pathname === '/owner/availability' && <OwnerAvailability />}
            {location.pathname === '/owner/bookings' && <OwnerBookings />}
            <Button
              loading={pending}
              onClick={() => {
                setPending(true);
                setError('');
                void signOut()
                  .then((result) => {
                    if (result.response?.status === 204)
                      void navigate('/owner/login', { replace: true });
                    else setError('Не удалось подтвердить выход. Повторите попытку.');
                  })
                  .catch(() =>
                    setError('Не удалось подтвердить выход. Проверьте соединение и повторите.'),
                  )
                  .finally(() => setPending(false));
              }}
            >
              Выйти
            </Button>
          </>
        )}
        <Text component={Link} to="/">
          На&nbsp;главную
        </Text>
      </Stack>
    </Container>
  );
}
