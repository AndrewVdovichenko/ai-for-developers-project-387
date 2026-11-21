import { Alert, Button, Container, Loader, PasswordInput, Stack, Title, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ownerReturn, readSession, signIn } from '../owner-api';

export function OwnerLoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const destination = ownerReturn(params.get('returnTo'));
  const [password, setPassword] = useState('');
  const [configured, setConfigured] = useState<boolean>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void readSession()
      .then((result) => {
        if (!active) return;
        if (result.data?.authenticated) void navigate(destination, { replace: true });
        else if (result.data) setConfigured(result.data.configured);
        else setError('Не удалось проверить доступ. Повторите попытку.');
      })
      .catch(() => {
        if (active) setError('Нет соединения. Повторите попытку.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, destination, navigate]);

  return (
    <Container size="xs" py="xl">
      <Stack>
        <Title order={1}>Вход Владельца</Title>
        {loading ? (
          <Loader aria-label="Проверяем доступ" />
        ) : (
          <>
            {configured === false && (
              <Alert color="yellow">
                Вход Владельца ещё не&nbsp;настроен. Обратитесь к&nbsp;человеку с&nbsp;доступом
                к&nbsp;серверу.
              </Alert>
            )}
            {error && (
              <Alert color="red" role="alert">
                {error}
              </Alert>
            )}
            {configured === undefined ? (
              <Button
                onClick={() => {
                  setLoading(true);
                  setError('');
                  setAttempt((value) => value + 1);
                }}
              >
                Повторить
              </Button>
            ) : (
              configured && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (pending) return;
                    setPending(true);
                    setError('');
                    void signIn(password)
                      .then((result) => {
                        if (!result.response) setError('Нет соединения. Повторите попытку.');
                        else if (result.data) {
                          setPassword('');
                          void navigate(destination, { replace: true });
                        } else if (result.error)
                          setError(
                            result.error.code === 'LOGIN_RATE_LIMITED'
                              ? `Слишком много попыток. Повторите через ${result.error.retryAfterSeconds} с.`
                              : result.error.message,
                          );
                        else setError('Нет соединения. Повторите попытку.');
                      })
                      .catch(() => setError('Нет соединения. Повторите попытку.'))
                      .finally(() => setPending(false));
                  }}
                >
                  <Stack>
                    <PasswordInput
                      label="Пароль"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.currentTarget.value)}
                      required
                      disabled={pending}
                    />
                    <Button type="submit" loading={pending}>
                      Войти
                    </Button>
                  </Stack>
                </form>
              )
            )}
          </>
        )}
        <Text component={Link} to="/">
          На&nbsp;главную
        </Text>
      </Stack>
    </Container>
  );
}
