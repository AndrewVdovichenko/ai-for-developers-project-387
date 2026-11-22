import { bookingTime, browserTimeZone } from '../booking-time';
import { Alert, Button, Container, Loader, Stack, Text, Title } from '@mantine/core';
import { getBooking } from '@calendar/api-client';
import type { Booking } from '@calendar/api-client';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { confirmationRecovery } from '../confirmation-recovery';
export function BookingResultPage() {
  const { id = '' } = useParams();
  const [booking, setBooking] = useState<Booking>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void getBooking({ baseUrl: location.origin, path: { id }, signal: AbortSignal.timeout(15000) })
      .then((result) => {
        if (!active) return;
        if (result.data) setBooking(result.data.booking);
        else
          setError(
            result.response?.status === 404
              ? 'Запись недоступна'
              : 'Не удалось загрузить Запись. Обновите страницу.',
          );
      })
      .catch(() => {
        if (active) setError('Не удалось загрузить Запись. Обновите страницу.');
      });
    return () => {
      active = false;
    };
  }, [id]);
  const zone = browserTimeZone();
  return (
    <Container size="sm" py="xl">
      <Stack>
        {error ? (
          <Alert role="alert" color="red">
            {error}
          </Alert>
        ) : booking ? (
          <>
            <Title order={1}>Вы записаны</Title>
            <Text>Номер Записи: {booking.id}</Text>
            <Title order={2}>{booking.eventTypeName}</Title>
            <Text>
              {bookingTime(booking.startsAt, zone)} — {bookingTime(booking.endsAt, zone)}
            </Text>
            <Text>Ваш часовой пояс: {zone}</Text>
            <Text>{booking.guestName}</Text>
            <Text>{booking.guestEmail}</Text>
            <Button
              component={Link}
              to="/event-types"
              onClick={() => confirmationRecovery().reset()}
            >
              Записаться ещё
            </Button>
          </>
        ) : (
          <Loader aria-label="Загружаем Запись" />
        )}
      </Stack>
    </Container>
  );
}
