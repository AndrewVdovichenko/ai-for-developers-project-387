import { Alert, Button, Group, Loader, Stack, Textarea, TextInput, Text } from '@mantine/core';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ApiError, CreateEventType, EventType, OperationResponse } from '@calendar/api-client';
import { EventTypeCard } from '../EventTypeCard';
import { listTypes, readCreation, sendCreation } from '../event-types-api';
import {
  clearCreation,
  fingerprint,
  loadCreationContext,
  persistCreation,
  resetDraft,
  typeDraft,
} from '../creation-context';
import type { CreationContext } from '../creation-context';

export function OwnerEventTypes() {
  const navigate = useNavigate();
  const [context, setContext] = useState(loadCreationContext);
  const [draft, setDraft] = useState(() =>
    context?.parameters
      ? {
          name: context.parameters.name,
          description: context.parameters.description ?? '',
          duration: String(context.parameters.durationMinutes),
        }
      : { ...typeDraft },
  );
  const [items, setItems] = useState<EventType[]>();
  const [created, setCreated] = useState<EventType>();
  const [error, setError] = useState('');
  const [listError, setListError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(!!context);
  const [copyMessage, setCopyMessage] = useState('');
  const busy = useRef(!!context);

  function requireLogin() {
    void navigate('/owner/login?returnTo=%2Fowner%2Fevent-types');
  }
  async function refresh() {
    setListError(false);
    try {
      const result = await listTypes();
      if (result.data) setItems(result.data.items);
      else setListError(true);
    } catch {
      setListError(true);
    }
  }
  function finish(response: OperationResponse) {
    clearCreation();
    setContext(undefined);
    if ('eventType' in response.body) {
      setCreated(response.body.eventType);
      setCopyMessage('');
      resetDraft();
      setDraft({ ...typeDraft });
      setFieldErrors({});
      setError('');
      void refresh();
    } else if ('code' in response.body) {
      const body: ApiError = response.body;
      setError(body.message);
      setFieldErrors(
        Object.fromEntries((body.fieldErrors ?? []).map((field) => [field.field, field.message])),
      );
    }
  }
  async function post(operation: CreationContext, parameters: CreateEventType) {
    const result = await sendCreation(operation.key, parameters);
    if (result.response?.status === 401) {
      requireLogin();
      return;
    }
    if (result.data) finish({ status: 201, body: result.data });
    else if (result.response && result.response.status < 500 && result.error)
      finish({ status: result.response.status, body: result.error });
    else setError('Исход пока неизвестен. Проверьте результат или повторите с тем же ключом.');
  }
  function applyRecovery(result: Awaited<ReturnType<typeof readCreation>>) {
    if (result.response?.status === 401) requireLogin();
    else if (result.data?.state === 'completed') finish(result.data.response);
    else if (result.data?.state === 'unknown') return 'unknown';
    else setError('Не удалось проверить результат. Повторите попытку.');
    return 'handled';
  }
  function showUnknown(operation: CreationContext) {
    setError(
      operation.parameters
        ? 'Исход пока неизвестен. Можно безопасно повторить операцию.'
        : 'Исход пока неизвестен. Введите исходные поля для повтора прежней операции.',
    );
  }
  async function recover(operation: CreationContext, repeat: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = await readCreation(operation.key);
      if (applyRecovery(result) === 'unknown') {
        if (repeat && operation.parameters) await post(operation, operation.parameters);
        else showUnknown(operation);
      }
    } catch {
      setError('Нет соединения. Исход операции пока неизвестен.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const initialized = useEffectEvent(
    ([catalog, recovery]: [
      PromiseSettledResult<Awaited<ReturnType<typeof listTypes>>>,
      PromiseSettledResult<Awaited<ReturnType<typeof readCreation>> | undefined>,
    ]) => {
      if (catalog.status === 'fulfilled' && catalog.value.data) setItems(catalog.value.data.items);
      else setListError(true);
      if (!context) return;
      if (recovery.status === 'fulfilled' && recovery.value) {
        if (applyRecovery(recovery.value) === 'unknown') showUnknown(context);
      } else setError('Нет соединения. Исход операции пока неизвестен.');
      busy.current = false;
      setPending(false);
    },
  );
  useEffect(() => {
    const saved = loadCreationContext();
    let active = true;
    void Promise.allSettled([
      listTypes(),
      saved ? readCreation(saved.key) : Promise.resolve(undefined),
    ]).then((results) => {
      if (active) initialized(results);
    });
    return () => {
      active = false;
    };
  }, []);

  function change(field: keyof typeof draft, value: string) {
    Object.assign(typeDraft, { [field]: value });
    setDraft({ ...typeDraft });
  }
  async function submit() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    setFieldErrors({});
    try {
      const errors: Record<string, string> = {};
      if ([...draft.name.trim()].length < 1 || [...draft.name.trim()].length > 100)
        errors.name = 'Название должно содержать от 1 до 100 символов';
      if ([...draft.description].length > 2000)
        errors.description = 'Описание должно содержать до 2000 символов';
      for (const field of ['name', 'description'] as const)
        if (draft[field].includes('\u0000')) errors[field] = 'Символ U+0000 недопустим';
      const durationMinutes = /^\d+$/.test(draft.duration) ? Number(draft.duration) : NaN;
      if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
        errors.durationMinutes = 'Длительность — целое число от 1 до 1440 минут';
      }
      if (Object.keys(errors).length) {
        setFieldErrors(errors);
        return;
      }
      const parameters = { name: draft.name, description: draft.description, durationMinutes };
      const hash = await fingerprint(parameters);
      if (context && context.fingerprint !== hash) {
        setError(
          'Для повтора нужны исходные параметры. Сначала проверьте результат прежней операции.',
        );
        return;
      }
      const operation = { key: context?.key ?? crypto.randomUUID(), fingerprint: hash, parameters };
      if (!persistCreation(operation)) {
        setError('Не удалось сохранить ключ операции. Разрешите хранилище браузера и повторите.');
        return;
      }
      setContext(operation);
      if (context) {
        const result = await readCreation(operation.key);
        if (applyRecovery(result) !== 'unknown') return;
      }
      await post(operation, parameters);
    } catch {
      setError('Нет соединения. Проверьте результат перед новой отправкой.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const locked = pending || !!context?.parameters;
  return (
    <Stack>
      {error && (
        <Alert role="alert" color="red">
          {error}
        </Alert>
      )}
      {context && (
        <>
          <Text>Сначала восстановите результат отправленной операции.</Text>
          <Button disabled={pending} onClick={() => void recover(context, true)}>
            Проверить результат / повторить
          </Button>
        </>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        <Stack>
          <TextInput
            label="Название"
            value={draft.name}
            error={fieldErrors.name}
            disabled={locked}
            onChange={(event) => change('name', event.currentTarget.value)}
          />
          <Textarea
            label="Описание"
            value={draft.description}
            error={fieldErrors.description}
            disabled={locked}
            onChange={(event) => change('description', event.currentTarget.value)}
          />
          <TextInput
            label="Длительность, минут"
            inputMode="numeric"
            value={draft.duration}
            error={fieldErrors.durationMinutes}
            disabled={locked}
            onChange={(event) => change('duration', event.currentTarget.value)}
          />
          <Button type="submit" loading={pending} disabled={!!context?.parameters}>
            Создать тип встречи
          </Button>
        </Stack>
      </form>
      {created && (
        <Alert color="green" component="output">
          <Stack>
            <Text>Тип встречи создан: {created.name}</Text>
            <Group>
              <Button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(`${window.location.origin}/booking/${created.id}`)
                    .then(() => setCopyMessage('Ссылка скопирована'))
                    .catch(() =>
                      setCopyMessage('Не удалось скопировать ссылку. Скопируйте адрес ниже.'),
                    );
                }}
              >
                Скопировать ссылку
              </Button>
              <Button
                component="a"
                href={`/booking/${created.id}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Открыть страницу записи
              </Button>
            </Group>
            <Text>{`${window.location.origin}/booking/${created.id}`}</Text>
            {copyMessage && <Text>{copyMessage}</Text>}
          </Stack>
        </Alert>
      )}
      {listError ? (
        <>
          <Alert color="red">Не удалось загрузить типы встреч</Alert>
          <Button onClick={() => void refresh()}>Повторить загрузку</Button>
        </>
      ) : items === undefined ? (
        <Loader aria-label="Загружаем типы встреч" />
      ) : items.length ? (
        items.map((type) => <EventTypeCard key={type.id} type={type} />)
      ) : (
        <Text>Пока нет типов встреч для записи</Text>
      )}
    </Stack>
  );
}
