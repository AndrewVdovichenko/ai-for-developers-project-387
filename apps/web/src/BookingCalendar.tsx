import { bookingTime, browserTimeZone } from './booking-time';
import { confirmationStorage } from './booking-draft';
import { BookingForm } from './BookingForm';
import { Link } from 'react-router';
import { Alert, Button, Stack, Text, Title } from '@mantine/core';
import {
  getCurrentHold,
  getHold,
  releaseHold,
  selectHold,
  getGuestOperation,
  guestSessionVerifyGuest,
} from '@calendar/api-client';
import type { Hold, Slot } from '@calendar/api-client';
import { ensureGuest } from './guest-api';
import { operationStorage } from './operation-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSlotAvailability } from '@calendar/api-client';
import type { SlotAvailability } from '@calendar/api-client';
import { SlotCalendar } from './SlotCalendar';

type SelectionContext = { key: string; fingerprint: string } & (
  | { action?: 'select'; eventTypeId: string; startsAt: string }
  | { action: 'release'; holdId: string }
);

export function BookingCalendar({ id }: { id: string }) {
  const [confirmLocked, setConfirmLocked] = useState(() => {
    const context = confirmationStorage().load();
    return !!context && !context.bookingId;
  });
  const [hold, setHold] = useState<Hold>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const deadline = useRef(0);
  const [picking, setPicking] = useState(false);
  const shown = useRef<Hold | null>(null);
  const working = useRef(false);
  const holdEpoch = useRef(0);
  const storage = useRef<ReturnType<typeof operationStorage<SelectionContext>>>(undefined);
  const showHold = useCallback((value: Hold | null, serverNow: string) => {
    shown.current = value;
    setHold(value ?? undefined);
    deadline.current = value
      ? performance.now() + Math.max(0, Date.parse(value.expiresAt) - Date.parse(serverNow))
      : 0;
    setRemaining(Math.max(0, Math.ceil((deadline.current - performance.now()) / 1000)));
  }, []);
  const completeSelection = useCallback(
    (result: { data?: unknown; error?: unknown; response?: { status: number } }) => {
      const status = result.response?.status;
      if (
        !result.data &&
        !(result.error && status !== undefined && status >= 400 && status < 500 && status !== 401)
      )
        return false;
      storage.current?.clear();
      setUnresolved(false);
      return true;
    },
    [],
  );
  const readCurrentHold = useCallback(
    async (isCurrent: () => boolean, failureMessage?: string) => {
      // Operation responses are historical; only this read represents the current choice.
      const current = await getCurrentHold({
        baseUrl: location.origin,
        signal: AbortSignal.timeout(15000),
      });
      if (!isCurrent()) return;
      if (current.data) showHold(current.data.hold, current.data.serverNow);
      else if (failureMessage) throw new Error(failureMessage);
    },
    [showHold],
  );
  useEffect(() => {
    storage.current = operationStorage('guest-selection', 'guest_selection', (context) => context);
    let active = true;
    const recover = async () => {
      const epoch = ++holdEpoch.current;
      try {
        const context = storage.current?.load();
        if (context) {
          setUnresolved(true);
          const result = await getGuestOperation({
            baseUrl: location.origin,
            path: { key: context.key },
            signal: AbortSignal.timeout(15000),
          });
          if (result.data?.state === 'completed') {
            const response = result.data.response;
            if (response.status >= 400 && 'message' in response.body) {
              setMessage(response.body.message);
              window.dispatchEvent(new Event('calendar:availability-conflict'));
            }
            // A completed lookup is authoritative even when its saved response is an error.
            completeSelection({ data: response });
          } else if (result.data?.state === 'unknown') {
            const verified = await guestSessionVerifyGuest({
              baseUrl: location.origin,
              signal: AbortSignal.timeout(15000),
            });
            if (!verified.data?.ready)
              throw new Error('Принадлежность прежнего выбора не подтверждена');
            const options = {
              baseUrl: location.origin,
              headers: { 'Idempotency-Key': context.key },
              signal: AbortSignal.timeout(15000),
            };
            const replay =
              context.action === 'release'
                ? await releaseHold({ ...options, path: { id: context.holdId }, body: {} })
                : await selectHold({
                    ...options,
                    body: { eventTypeId: context.eventTypeId, startsAt: context.startsAt },
                  });
            if (completeSelection(replay)) {
              if (replay.error) {
                setMessage(replay.error.message);
                window.dispatchEvent(new Event('calendar:availability-conflict'));
              }
            } else throw new Error('Исход выбора пока неизвестен');
          }
        }
        if (storage.current?.load()) throw new Error('Исход выбора пока неизвестен');
        await readCurrentHold(() => active && epoch === holdEpoch.current);
      } catch {
        if (active && epoch === holdEpoch.current)
          setMessage('Не удалось восстановить выбор. Обновите страницу для повторной проверки.');
      }
    };
    void recover();
    const reconcile = async () => {
      if (document.visibilityState !== 'visible' || working.current || storage.current?.load())
        return;
      const epoch = ++holdEpoch.current;
      const previous = shown.current;
      try {
        const specific = previous
          ? await getHold({
              baseUrl: location.origin,
              path: { id: previous.id },
              signal: AbortSignal.timeout(15000),
            })
          : undefined;
        if (working.current || storage.current?.load() || !active || epoch !== holdEpoch.current)
          return;
        if (specific && !specific.data) throw new Error('Бронирование недоступно');
        const current = await getCurrentHold({
          baseUrl: location.origin,
          signal: AbortSignal.timeout(15000),
        });
        if (working.current || storage.current?.load() || !active || epoch !== holdEpoch.current)
          return;
        if (!previous && current.response?.status === 401) return;
        if (!current.data) throw new Error('Не удалось проверить выбор');
        if (
          previous &&
          (current.data.hold?.id !== previous.id ||
            (specific?.data &&
              previous.state !== specific.data.hold.state &&
              ['replaced', 'released'].includes(specific.data.hold.state)))
        ) {
          setMessage('Выбор изменён в другой вкладке. Проверьте актуальное Бронирование.');
          setPicking(false);
        }
        showHold(current.data.hold, current.data.serverNow);
      } catch {
        if (active && epoch === holdEpoch.current)
          setMessage('Не удалось обновить Бронирование. Показан прежний выбор.');
      }
    };
    const visible = () => {
      void reconcile();
    };
    window.addEventListener('focus', visible);
    window.addEventListener('online', visible);
    window.addEventListener('storage', visible);
    document.addEventListener('visibilitychange', visible);
    const refreshTimer = window.setInterval(visible, 60000);
    const timer = window.setInterval(
      () => setRemaining(Math.max(0, Math.ceil((deadline.current - performance.now()) / 1000))),
      1000,
    );
    return () => {
      active = false;
      clearInterval(timer);
      clearInterval(refreshTimer);
      window.removeEventListener('focus', visible);
      window.removeEventListener('online', visible);
      window.removeEventListener('storage', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [completeSelection, readCurrentHold, showHold]);
  const choose = async (slot: Slot) => {
    if (working.current || storage.current?.load()) return;
    const epoch = ++holdEpoch.current;
    working.current = true;
    setBusy(true);
    setMessage('');
    try {
      await ensureGuest();
      const context = {
        action: 'select' as const,
        key: crypto.randomUUID(),
        fingerprint: JSON.stringify([id, slot.startsAt]),
        eventTypeId: id,
        startsAt: slot.startsAt,
      };
      if (!storage.current?.persist(context))
        throw new Error(
          'Не удалось сохранить ключ операции. Разрешите хранилище браузера и cookie.',
        );
      setUnresolved(true);
      const result = await selectHold({
        baseUrl: location.origin,
        headers: { 'Idempotency-Key': context.key },
        body: { eventTypeId: id, startsAt: slot.startsAt },
        signal: AbortSignal.timeout(15000),
      });
      if (!completeSelection(result))
        throw new Error('Ответ потерян. Обновите страницу для проверки результата.');
      if (result.data) {
        await readCurrentHold(
          () => epoch === holdEpoch.current,
          'Выбор сохранён. Не удалось обновить актуальное Бронирование.',
        );
        setPicking(false);
        if (confirmationStorage().load()?.bookingId) confirmationStorage().clear();
      } else {
        setMessage(result.error!.message);
        window.dispatchEvent(new Event('calendar:availability-conflict'));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось выполнить выбор');
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const release = async () => {
    if (!hold || working.current || storage.current?.load()) return;
    const epoch = ++holdEpoch.current;
    working.current = true;
    setBusy(true);
    setMessage('');
    try {
      const context: SelectionContext = {
        action: 'release',
        key: crypto.randomUUID(),
        fingerprint: JSON.stringify(['release', hold.id]),
        holdId: hold.id,
      };
      if (!storage.current?.persist(context))
        throw new Error(
          'Не удалось сохранить ключ операции. Разрешите хранилище браузера и cookie.',
        );
      setUnresolved(true);
      const result = await releaseHold({
        baseUrl: location.origin,
        path: { id: hold.id },
        headers: { 'Idempotency-Key': context.key },
        body: {},
        signal: AbortSignal.timeout(15000),
      });
      if (completeSelection(result)) {
        if (result.data) {
          await readCurrentHold(
            () => epoch === holdEpoch.current,
            'Освобождение сохранено. Не удалось обновить актуальное Бронирование.',
          );
          setPicking(false);
          window.dispatchEvent(new Event('calendar:availability-conflict'));
        } else setMessage(result.error!.message);
      } else throw new Error('Исход освобождения неизвестен. Проверьте результат операции.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось освободить Бронирование');
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const [data, setData] = useState<SlotAvailability>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [day, setDay] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await getSlotAvailability({
        baseUrl: window.location.origin,
        path: { id },
        signal: AbortSignal.timeout(15_000),
      });
      if (current !== generation.current) return;
      if (!result.data) throw new Error('unavailable');
      setData(result.data);
      setError(false);
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [id]);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    // Future Hold conflicts dispatch this after a failed mutating choice.
    window.addEventListener('calendar:availability-conflict', visible);
    const timer = window.setInterval(visible, 60_000);
    return () => {
      active = false;
      invalidate();
      window.clearInterval(timer);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('calendar:availability-conflict', visible);
    };
  }, [refresh, invalidate]);
  return (
    <Stack>
      {unresolved && <Button onClick={() => location.reload()}>Проверить результат выбора</Button>}
      {message && (
        <Alert color="red" role="alert">
          {message}
        </Alert>
      )}
      {hold ? (
        <Stack aria-label="Выбранное Бронирование">
          <Title order={3}>
            {hold.state === 'released'
              ? 'Бронирование освобождено'
              : hold.state === 'replaced'
                ? 'Бронирование заменено'
                : 'Слот выбран'}
          </Title>
          <Text>
            {bookingTime(hold.startsAt)} — {bookingTime(hold.endsAt)}
          </Text>
          <Text>Ваш часовой пояс: {browserTimeZone()}</Text>
          {(hold.state === 'active' || hold.state === 'expired') && (
            <Text role="timer">
              {remaining > 0
                ? `Осталось ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
                : 'Срок бронирования истёк. При подтверждении проверим, свободен ли слот'}
            </Text>
          )}
          <Text size="sm">Номер Бронирования: {hold.id}</Text>
          {(hold.state === 'active' || hold.state === 'expired') && (
            <>
              <Button
                disabled={busy || unresolved || confirmLocked}
                onClick={() => {
                  setPicking(true);
                  void refresh();
                }}
              >
                Выбрать другой Слот
              </Button>
              <Button
                disabled={busy || unresolved || confirmLocked}
                variant="outline"
                onClick={() => void release()}
              >
                Освободить Бронирование
              </Button>
            </>
          )}
        </Stack>
      ) : null}
      <BookingForm
        hold={hold}
        disabled={busy || unresolved || hold?.state === 'confirmed'}
        onLocked={setConfirmLocked}
      />
      {hold?.state === 'confirmed' && hold.bookingId && (
        <Button component={Link} to={`/bookings/${hold.bookingId}`}>
          Открыть Запись
        </Button>
      )}
      {(!hold ||
        picking ||
        hold.state === 'released' ||
        hold.state === 'replaced' ||
        hold.state === 'confirmed') && (
        <SlotCalendar
          data={data}
          loading={loading}
          error={error}
          day={day}
          timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          onDayChange={(value) => {
            setDay(value);
            void refresh();
          }}
          onSelect={busy || unresolved || confirmLocked ? undefined : (slot) => void choose(slot)}
          onRetry={() => void refresh()}
        />
      )}
    </Stack>
  );
}
