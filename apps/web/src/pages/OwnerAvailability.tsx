import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type {
  AvailabilitySettings,
  AvailabilityPreview,
  OperationResponse,
  SaveAvailability,
} from '@calendar/api-client';
import {
  readAvailability,
  readSave,
  sendAvailability,
  previewAvailability,
} from '../availability-api';
import {
  availabilityDraft,
  draftFrom,
  parametersFrom,
  saveFingerprint,
  saveStorage,
  time,
} from '../availability-draft';
import type { Draft, SaveContext } from '../availability-draft';

const names = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export function OwnerAvailability() {
  const navigate = useNavigate();
  const [context, setContext] = useState(saveStorage.load);
  const [draft, setDraft] = useState<Draft | undefined>(
    () =>
      availabilityDraft.current ??
      (context?.parameters ? draftFrom({ ...context.parameters, configured: true }) : undefined),
  );
  const [current, setCurrent] = useState<AvailabilitySettings>();
  const [preview, setPreview] = useState<AvailabilityPreview>();
  const [zoneEditing, setZoneEditing] = useState(false);
  const [suppressed, setSuppressed] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem('calendar-zone-proposal') ?? '[]');
      return Array.isArray(value)
        ? value.filter((pair): pair is string => typeof pair === 'string')
        : [];
    } catch {
      return [];
    }
  });
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(true);
  function requireLogin() {
    void navigate('/owner/login?returnTo=%2Fowner%2Favailability');
  }
  function change(next: Draft) {
    setPreview(undefined);
    availabilityDraft.current = next;
    setDraft(next);
    setMessage('');
  }
  function updateInterval(
    dayIndex: number,
    intervalIndex: number,
    patch: Partial<Draft['days'][number]['intervals'][number]>,
  ) {
    if (!draft) return;
    change({
      ...draft,
      days: draft.days.map((day, index) =>
        index !== dayIndex
          ? day
          : {
              ...day,
              intervals: day.intervals.map((interval, position) =>
                position !== intervalIndex ? interval : { ...interval, ...patch },
              ),
            },
      ),
    });
  }
  async function refresh() {
    const result = await readAvailability();
    if (result.response?.status === 401) {
      requireLogin();
      return;
    }
    if (!result.data) throw new Error('Не удалось загрузить Расписание. Повторите попытку.');
    setCurrent(result.data.availability);
    return result.data.availability;
  }
  async function finish(response: OperationResponse) {
    if (!('availability' in response.body) && !('code' in response.body))
      throw new Error('Неожиданный результат операции');
    setPreview(undefined);
    saveStorage.clear();
    setContext(undefined);
    if ('availability' in response.body) {
      setCurrent(response.body.availability);
      change(draftFrom(response.body.availability));
      availabilityDraft.current = undefined;
      setMessage('Расписание сохранено');
      setError('');
      setConflict(false);
      setZoneEditing(false);
    } else {
      setError(
        [
          response.body.message,
          ...(response.body.fieldErrors ?? []).map((field) => `${field.field}: ${field.message}`),
        ].join('. '),
      );
      if (response.body.code === 'REVISION_CONFLICT') {
        setConflict(true);
        setCurrent(undefined);
        await refresh();
      }
    }
  }
  async function post(operation: SaveContext, parameters: SaveAvailability) {
    const result = await sendAvailability(operation.key, parameters);
    if (result.response?.status === 401) {
      requireLogin();
      return;
    }
    if (result.data) await finish({ status: 200, body: result.data });
    else if (result.response && result.response.status < 500 && result.error)
      await finish({ status: result.response.status, body: result.error });
    else setError('Исход пока неизвестен. Проверьте результат или повторите с тем же ключом.');
  }
  async function check(operation: SaveContext) {
    const result = await readSave(operation.key);
    if (result.response?.status === 401) {
      requireLogin();
      return false;
    }
    if (result.data?.state === 'completed') {
      await finish(result.data.response);
      return false;
    }
    if (result.data?.state === 'unknown') return true;
    throw new Error('Не удалось проверить результат. Исход пока неизвестен.');
  }
  const initialize = useEffectEvent(async () => {
    try {
      const operation = saveStorage.load();
      // Always resolve the old operation before permitting any new save.
      const unknown = operation ? await check(operation) : false;
      const settings = await refresh();
      if (!settings) return;
      if (!availabilityDraft.current && (!operation?.parameters || unknown)) {
        setDraft(
          operation?.parameters
            ? draftFrom({ ...operation.parameters, configured: true })
            : { ...draftFrom(settings), revision: operation?.revision ?? settings.revision },
        );
      }
      if (unknown)
        setError(
          operation?.parameters
            ? 'Исход пока неизвестен. Можно повторить исходную операцию.'
            : 'Исход пока неизвестен. Введите исходные поля для повтора прежней операции.',
        );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Нет соединения. Повторите попытку.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  });
  useEffect(() => {
    void Promise.resolve().then(() => initialize());
  }, [attempt]);
  async function run(work: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    setMessage('');
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Нет соединения. Исход операции пока неизвестен.',
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function submit(confirmationToken?: string) {
    if (!draft || conflict) return;
    await run(async () => {
      const parameters = parametersFrom(draft);
      if (confirmationToken) parameters.confirmationToken = confirmationToken;
      if (context?.confirmationToken) parameters.confirmationToken = context.confirmationToken;
      if (
        !context &&
        current?.configured &&
        current.timeZone !== parameters.timeZone &&
        !confirmationToken
      ) {
        const result = await previewAvailability(parameters);
        if (result.response?.status === 401) {
          requireLogin();
          return;
        }
        if (!result.data) {
          if (result.error?.code === 'REVISION_CONFLICT') {
            setConflict(true);
            await refresh();
          }
          throw new Error(
            result.error?.message ?? 'Не удалось получить просмотр последствий. Повторите попытку.',
          );
        }
        setPreview(result.data);
        return;
      }
      if (!parameters.timeZone) throw new Error('Выберите IANA-пояс календаря');
      const fingerprint = await saveFingerprint(parameters);
      if (context && context.fingerprint !== fingerprint)
        throw new Error(
          'Для повтора нужны исходные параметры. Сначала проверьте результат прежней операции.',
        );
      const operation = {
        key: context?.key ?? crypto.randomUUID(),
        fingerprint,
        revision: parameters.revision,
        ...(parameters.confirmationToken
          ? { confirmationToken: parameters.confirmationToken }
          : {}),
        parameters,
      };
      if (!saveStorage.persist(operation))
        throw new Error(
          'Не удалось сохранить ключ операции. Разрешите хранилище браузера и повторите.',
        );
      setContext(operation);
      if (context && !(await check(operation))) return;
      await post(operation, parameters);
    });
  }
  const locked = pending || !!context?.parameters;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zonePair = `${current?.timeZone}|${browserZone}`;
  function suppressProposal() {
    const pairs = [...suppressed, zonePair];
    setSuppressed(pairs);
    try {
      localStorage.setItem('calendar-zone-proposal', JSON.stringify(pairs));
    } catch {
      /* The current tab still remembers the refusal. */
    }
  }
  return (
    <Stack>
      <Modal
        opened={!!preview}
        onClose={() => setPreview(undefined)}
        title="Последствия смены пояса"
        closeOnClickOutside={!pending}
        closeOnEscape={!pending}
        withCloseButton={!pending}
      >
        {preview && draft && (
          <Stack>
            <Text>Новый пояс календаря: {draft.timeZone}</Text>
            <Text>
              Местные рабочие часы сохраняются. UTC-моменты существующих Записей и Бронирований
              остаются прежними.
            </Text>
            {draft.days.map((day) => (
              <Text key={day.weekday}>
                {names[day.weekday - 1]}:{' '}
                {day.intervals.map((i) => `${i.start}–${i.end}`).join(', ') || 'выходной'}
              </Text>
            ))}
            <Text>Затронутые Записи: {preview.affectedBookings.length}</Text>
            {preview.affectedBookings.map((item) => (
              <Text key={item.id}>
                {item.eventTypeName}: {item.startsAt} — {item.endsAt}
              </Text>
            ))}
            <Text>Действующие Бронирования: {preview.affectedHolds.length}</Text>
            {preview.affectedHolds.map((item) => (
              <Text key={item.id}>
                {item.eventTypeName}: {item.startsAt} — {item.endsAt}; действует до {item.expiresAt}
              </Text>
            ))}
            <Button disabled={pending} onClick={() => void submit(preview.confirmationToken)}>
              Подтвердить смену пояса
            </Button>
            <Button disabled={pending} variant="default" onClick={() => setPreview(undefined)}>
              Оставить черновик
            </Button>
          </Stack>
        )}
      </Modal>
      {error && (
        <Alert role="alert" color="red">
          {error}
        </Alert>
      )}
      {message && (
        <output>
          <Alert color="green">{message}</Alert>
        </output>
      )}
      {context && (
        <Button
          disabled={pending}
          onClick={() =>
            void run(async () => {
              if (await check(context)) {
                if (context.parameters) await post(context, context.parameters);
                else setError('Введите исходные поля для повтора прежней операции.');
              }
            })
          }
        >
          Проверить результат / повторить
        </Button>
      )}
      {!draft ? (
        pending ? (
          <Loader aria-label="Загружаем Расписание" />
        ) : (
          <Button
            onClick={() => {
              busy.current = true;
              setPending(true);
              setAttempt((value) => value + 1);
            }}
          >
            Повторить загрузку
          </Button>
        )
      ) : (
        <>
          <Text>Пояс браузера: {browserZone}</Text>
          <Text>Сохранённый пояс календаря: {current?.timeZone ?? 'ещё не настроен'}</Text>
          {current?.configured &&
            current.timeZone !== browserZone &&
            !suppressed.includes(zonePair) &&
            !context && (
              <Paper withBorder p="md">
                <Text>Пояс браузера отличается от пояса календаря</Text>
                <Group>
                  <Button
                    disabled={locked}
                    onClick={() => {
                      suppressProposal();
                      setZoneEditing(true);
                      change({ ...draft, timeZone: browserZone });
                    }}
                  >
                    Изменить пояс
                  </Button>
                  <Button disabled={locked} variant="default" onClick={suppressProposal}>
                    Оставить текущий
                  </Button>
                </Group>
              </Paper>
            )}
          {current?.configured && (
            <Button variant="subtle" disabled={locked} onClick={() => setZoneEditing(true)}>
              Изменить пояс вручную
            </Button>
          )}
          <TextInput
            label="Часовой пояс календаря"
            description={
              current?.configured
                ? 'Перед сохранением нового пояса просмотрите последствия.'
                : 'Браузер предложил пояс. Проверьте его перед первым сохранением.'
            }
            value={draft.timeZone}
            disabled={locked || (!!current?.configured && !zoneEditing)}
            onChange={(event) => change({ ...draft, timeZone: event.currentTarget.value })}
          />
          <Text>
            Рабочие часы в&nbsp;поясе календаря: {draft.timeZone}. Ночные часы задавайте частями
            в&nbsp;разных днях.
          </Text>
          <Paper withBorder p="md">
            <Stack>
              <Text>Дни для&nbsp;массовой замены интервалов</Text>
              <Group>
                {names.map((name, index) => (
                  <Checkbox
                    key={name}
                    label={`Применить к: ${name}`}
                    disabled={locked}
                    checked={selected.includes(index + 1)}
                    onChange={(event) =>
                      setSelected(
                        event.currentTarget.checked
                          ? [...selected, index + 1]
                          : selected.filter((day) => day !== index + 1),
                      )
                    }
                  />
                ))}
              </Group>
            </Stack>
          </Paper>
          {draft.days.map((day, index) => (
            <Paper withBorder p="md" key={day.weekday}>
              <Stack>
                <Title order={2} size="h4">
                  {names[index]}
                </Title>
                {!day.intervals.length && <Text>{names[index]}: выходной</Text>}
                {day.intervals.map((interval, position) => (
                  <Group key={position} align="end">
                    <TextInput
                      label={`${names[index]}: начало ${position + 1}`}
                      value={interval.start}
                      placeholder="09:00"
                      disabled={locked}
                      onChange={(event) =>
                        updateInterval(index, position, { start: event.currentTarget.value })
                      }
                    />
                    <TextInput
                      label={`${names[index]}: конец ${position + 1}`}
                      value={interval.end}
                      placeholder="18:00"
                      disabled={locked}
                      onChange={(event) =>
                        updateInterval(index, position, { end: event.currentTarget.value })
                      }
                    />
                    <Button
                      variant="subtle"
                      disabled={locked}
                      onClick={() =>
                        change({
                          ...draft,
                          days: draft.days.map((item, i) =>
                            i !== index
                              ? item
                              : {
                                  ...item,
                                  intervals: item.intervals.filter((_, p) => p !== position),
                                },
                          ),
                        })
                      }
                    >
                      {names[index]}: удалить интервал {position + 1}
                    </Button>
                  </Group>
                ))}
                <Group>
                  <Button
                    variant="light"
                    disabled={locked}
                    onClick={() =>
                      change({
                        ...draft,
                        days: draft.days.map((item, i) =>
                          i !== index
                            ? item
                            : {
                                ...item,
                                intervals: [...item.intervals, { start: '09:00', end: '18:00' }],
                              },
                        ),
                      })
                    }
                  >
                    {names[index]}: добавить интервал
                  </Button>
                  <Button
                    variant="light"
                    disabled={locked || !selected.length}
                    onClick={() =>
                      change({
                        ...draft,
                        days: draft.days.map((item) =>
                          selected.includes(item.weekday)
                            ? { ...item, intervals: day.intervals.map((part) => ({ ...part })) }
                            : item,
                        ),
                      })
                    }
                  >
                    {names[index]}: применить к&nbsp;выбранным дням
                  </Button>
                </Group>
              </Stack>
            </Paper>
          ))}
          {conflict && !current && (
            <Button
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await refresh();
                })
              }
            >
              Повторить загрузку актуального Расписания
            </Button>
          )}
          {conflict && current && (
            <Paper withBorder p="md">
              <Stack>
                <Text>
                  Актуальное Расписание: версия {current.revision}, пояс {current.timeZone}
                </Text>
                {current.days.map((day) => (
                  <Text key={day.weekday}>
                    {names[day.weekday - 1]}:{' '}
                    {day.intervals.length
                      ? day.intervals
                          .map(
                            (interval) =>
                              `${time(interval.startMinute)}–${time(interval.endMinute)}`,
                          )
                          .join(', ')
                      : 'выходной'}
                  </Text>
                ))}
                <Button
                  disabled={pending}
                  onClick={() => {
                    change({
                      ...draft,
                      revision: current.revision,
                    });
                    setConflict(false);
                    setError('');
                  }}
                >
                  Оставить черновик поверх актуальной версии
                </Button>
                <Button
                  disabled={pending}
                  onClick={() => {
                    change(draftFrom(current));
                    setConflict(false);
                    setError('');
                  }}
                >
                  Загрузить актуальное Расписание
                </Button>
              </Stack>
            </Paper>
          )}
          <Button
            loading={pending}
            disabled={!!context?.parameters || conflict}
            onClick={() => void submit()}
          >
            Сохранить Расписание
          </Button>
        </>
      )}
    </Stack>
  );
}
