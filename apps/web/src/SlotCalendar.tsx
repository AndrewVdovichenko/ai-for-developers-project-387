import { Alert, Button, Group, Loader, NativeSelect, Paper, Stack, Text } from '@mantine/core';
import type { Slot, SlotAvailability } from '@calendar/api-client';

function slotDay(instant: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}
export function SlotCalendar({
  data,
  loading,
  error,
  day,
  timeZone,
  onDayChange,
  onRetry,
  onSelect,
}: {
  data?: SlotAvailability;
  loading: boolean;
  error: boolean;
  day: string;
  timeZone: string;
  onDayChange: (day: string) => void;
  onRetry: () => void;
  onSelect?: (slot: Slot) => void;
}) {
  const days: string[] = [];
  if (data?.windowStartsAt && data.windowEndsAt) {
    const first = slotDay(data.windowStartsAt, timeZone);
    const last = slotDay(
      new Date(new Date(data.windowEndsAt).getTime() - 1).toISOString(),
      timeZone,
    );
    for (
      let date = new Date(`${first}T12:00:00Z`);
      date.toISOString().slice(0, 10) <= last;
      date.setUTCDate(date.getUTCDate() + 1)
    )
      days.push(date.toISOString().slice(0, 10));
  }
  const chosen = days.includes(day)
    ? day
    : data?.slots[0]
      ? slotDay(data.slots[0].startsAt, timeZone)
      : (days[0] ?? '');
  const slots = data?.slots.filter((slot) => slotDay(slot.startsAt, timeZone) === chosen) ?? [];
  const date = (instant: string) =>
    new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(instant));
  const time = (instant: string) =>
    new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'longOffset',
      hourCycle: 'h23',
    }).format(new Date(instant));
  return (
    <Stack>
      <Text>Ваш часовой пояс: {timeZone}</Text>
      {loading && (
        <Group>
          <Loader size="sm" aria-label="Загружаем Слоты" />
          <Text component="output">Обновляем доступность…</Text>
        </Group>
      )}
      {error && (
        <Alert role="alert" color="red">
          Не&nbsp;удалось загрузить Слоты.{data && ' Данные устарели.'}
          <Button onClick={onRetry} variant="subtle">
            Повторить загрузку Слотов
          </Button>
        </Alert>
      )}
      {data && (
        <>
          {!data.configured ? (
            <Text>Расписание пока не&nbsp;настроено.</Text>
          ) : data.slots.length === 0 ? (
            <Text>Нет доступных Слотов в&nbsp;окне записи.</Text>
          ) : (
            <>
              <NativeSelect
                label="День записи"
                value={chosen}
                data={days.map((value) => ({
                  value,
                  label: new Intl.DateTimeFormat('ru-RU', {
                    timeZone: 'UTC',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  }).format(new Date(`${value}T12:00:00Z`)),
                }))}
                onChange={(event) => onDayChange(event.currentTarget.value)}
              />
              {slots.length === 0 && <Text>В&nbsp;этот день нет доступных Слотов.</Text>}
              <Stack
                component="ul"
                aria-label="Свободные Слоты"
                p={0}
                style={{ listStyle: 'none' }}
              >
                {slots.map((slot) => (
                  <Paper component="li" key={slot.startsAt} withBorder p="sm">
                    {onSelect ? (
                      <Button variant="light" onClick={() => onSelect(slot)}>
                        {time(slot.startsAt)} — {time(slot.endsAt)}
                      </Button>
                    ) : (
                      <Text>
                        {time(slot.startsAt)} — {time(slot.endsAt)}
                      </Text>
                    )}
                    {slotDay(slot.startsAt, timeZone) !== slotDay(slot.endsAt, timeZone) && (
                      <Text size="sm">
                        {date(slot.startsAt)} — {date(slot.endsAt)}
                      </Text>
                    )}
                  </Paper>
                ))}
              </Stack>
            </>
          )}
        </>
      )}
    </Stack>
  );
}
