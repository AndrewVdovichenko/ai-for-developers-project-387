import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { listOwnerBookings } from '@calendar/api-client';
import type { Booking, EventType, OwnerBookings as OwnerBookingsData } from '@calendar/api-client';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { listTypes } from '../event-types-api';
import { bookingTime, browserTimeZone } from '../booking-time';

export function OwnerBookings() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [types, setTypes] = useState<EventType[]>([]);
  const [data, setData] = useState<OwnerBookingsData>();
  const [loadedFilter, setLoadedFilter] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const raw = params.getAll('eventTypeId');
  const selected = [...new Set(raw.map((id) => id.toLowerCase()))];
  const filter = JSON.stringify(selected);
  useEffect(() => {
    const raw = params.getAll('eventTypeId');
    const selected = [...new Set(raw.map((id) => id.toLowerCase()))];
    if (JSON.stringify(raw) === JSON.stringify(selected)) return;
    const canonical = new URLSearchParams(params);
    canonical.delete('eventTypeId');
    for (const id of selected) canonical.append('eventTypeId', id);
    setParams(canonical, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setPending(true);
    });
    void Promise.all([
      listOwnerBookings({
        baseUrl: window.location.origin,
        credentials: 'same-origin',
        query: { eventTypeId: JSON.parse(filter) as string[] },
        signal: AbortSignal.timeout(15000),
      }),
      listTypes(),
    ])
      .then(([result, catalog]) => {
        if (!active) return;
        if (result.error?.code === 'OWNER_AUTH_REQUIRED') {
          void navigate(
            `/owner/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`,
            { replace: true },
          );
          return;
        }
        if (catalog.data) setTypes(catalog.data.items);
        if (result.data && catalog.data) {
          setData(result.data);
          setLoadedFilter(filter);
          setError('');
        } else
          setError(
            result.error?.code === 'INVALID_FILTER'
              ? result.error.message
              : 'Не удалось обновить встречи. Повторите попытку.',
          );
      })
      .catch(() => {
        if (active) setError('Нет соединения. Не удалось обновить встречи.');
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [filter, attempt, navigate, location.pathname, location.search]);

  useEffect(() => {
    const refresh = () => setAttempt((value) => value + 1);
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(visible, 60000);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', visible);
      window.clearInterval(timer);
    };
  }, []);
  const update = (ids: string[]) => {
    const next = new URLSearchParams(params);
    next.delete('eventTypeId');
    for (const id of ids) next.append('eventTypeId', id);
    setParams(next);
  };
  const zone = browserTimeZone();
  const currentData = loadedFilter === filter ? data : undefined;
  return (
    <Stack>
      <Text>Ваш часовой пояс: {zone}</Text>
      <Title order={2}>Фильтр по&nbsp;Типам встречи</Title>
      <Group>
        {types.map((type) => (
          <Checkbox
            key={type.id}
            label={type.name}
            checked={selected.includes(type.id)}
            onChange={(event) =>
              update(
                event.currentTarget.checked
                  ? [...selected, type.id]
                  : selected.filter((id) => id !== type.id),
              )
            }
          />
        ))}
      </Group>
      <Group>
        <Button loading={pending} onClick={() => setAttempt((value) => value + 1)}>
          Обновить
        </Button>
        {raw.length > 0 && (
          <Button variant="light" onClick={() => update([])}>
            Сбросить фильтр
          </Button>
        )}
      </Group>
      {error && (
        <Alert role="alert" color="red">
          {error}
          {currentData && <Text>Данные могут быть неактуальны.</Text>}
        </Alert>
      )}
      {!currentData && pending && <Loader aria-label="Загружаем встречи" />}
      {currentData && !error && currentData.items.length === 0 && (
        <Text>
          {raw.length ? 'Нет предстоящих встреч выбранных типов' : 'Предстоящих встреч пока нет'}
        </Text>
      )}
      {currentData && (
        <Stack
          component="ul"
          aria-label="Предстоящие встречи"
          style={{ listStyle: 'none', padding: 0 }}
        >
          {currentData.items.map((booking: Booking) => (
            <Paper component="li" key={booking.id} p="md" withBorder>
              <Stack gap="xs">
                <Title order={3}>{booking.eventTypeName}</Title>
                {booking.startsAt <= currentData.serverNow && <Badge>Идёт сейчас</Badge>}
                <Text>
                  {bookingTime(booking.startsAt, zone)} — {bookingTime(booking.endsAt, zone)}
                </Text>
                <Text>{booking.guestName}</Text>
                <Text>{booking.guestEmail}</Text>
                <Text component={Link} to={`/bookings/${booking.id}`}>
                  Подробности Записи
                </Text>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
