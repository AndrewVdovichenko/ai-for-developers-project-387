import { Alert, Button, Stack, TextInput } from '@mantine/core';
import type { Hold } from '@calendar/api-client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router';
import { loadBookingDraft, saveBookingDraft } from './booking-draft';
import { confirmationRecovery } from './confirmation-recovery';

export function BookingForm({
  hold,
  disabled,
  onLocked,
}: {
  hold?: Hold;
  disabled: boolean;
  onLocked: (locked: boolean) => void;
}) {
  const navigate = useNavigate();
  const [recovery] = useState(confirmationRecovery);
  const state = useSyncExternalStore(recovery.subscribe, recovery.getSnapshot);
  const [body, setBody] = useState(loadBookingDraft);
  const [validationErrors, setErrors] = useState<Record<string, string>>({});
  const errors = {
    ...Object.fromEntries((state.error?.fieldErrors ?? []).map((e) => [e.field, e.message])),
    ...validationErrors,
  };
  useEffect(() => onLocked(state.locked || state.sending), [onLocked, state.locked, state.sending]);
  useEffect(() => {
    if (state.bookingId) navigate(`/bookings/${state.bookingId}`, { replace: true });
  }, [state.bookingId, navigate]);
  const submit = async () => {
    if (!hold || state.sending || (disabled && !state.needsInput)) return;
    const normalized = { guestName: body.guestName.trim(), guestEmail: body.guestEmail.trim() };
    const next: Record<string, string> = {};
    if ([...normalized.guestName].length < 1 || [...normalized.guestName].length > 100)
      next.guestName = 'Введите имя от 1 до 100 символов';
    if (
      [...normalized.guestEmail].length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized.guestEmail)
    )
      next.guestEmail = 'Введите email до 254 символов в формате имя@домен.зона';
    setErrors(next);
    if (!Object.keys(next).length) await recovery.submit(hold.id, normalized);
  };
  const editable = !state.sending && (!state.locked || state.needsInput);
  const showForm =
    hold && (hold.state === 'active' || hold.state === 'expired' || state.needsInput);
  return (
    <Stack>
      {state.message && (
        <Alert role="alert" color={state.locked ? 'yellow' : 'red'}>
          {state.message}
        </Alert>
      )}
      {state.locked && !state.sending && !state.needsInput && (
        // An explicit new booking intent outweighs an unresolved confirmation of the previous one.
        // While the first POST is still awaiting its reply the escape appears only after timeout.
        <Button
          component={Link}
          to="/event-types"
          variant="outline"
          onClick={() => recovery.reset()}
        >
          Записаться ещё
        </Button>
      )}
      {showForm && (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          aria-label="Данные для записи"
        >
          <Stack>
            <TextInput
              aria-label="Имя"
              label="Имя"
              required
              value={body.guestName}
              error={errors.guestName}
              disabled={!editable}
              onChange={(event) => {
                const value = { ...body, guestName: event.currentTarget.value };
                setBody(value);
                saveBookingDraft(value);
              }}
            />
            <TextInput
              aria-label="Email"
              label="Email"
              required
              type="text"
              inputMode="email"
              value={body.guestEmail}
              error={errors.guestEmail}
              disabled={!editable}
              onChange={(event) => {
                const value = { ...body, guestEmail: event.currentTarget.value };
                setBody(value);
                saveBookingDraft(value);
              }}
            />
            <Button
              type="submit"
              disabled={!editable || (disabled && !state.needsInput)}
              loading={state.sending}
            >
              {state.sending ? 'Записываем…' : 'Подтвердить запись'}
            </Button>
          </Stack>
        </form>
      )}
    </Stack>
  );
}
