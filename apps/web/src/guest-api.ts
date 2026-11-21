import { guestSessionPrepareGuest, guestSessionVerifyGuest } from '@calendar/api-client';
let preparing: Promise<void> | undefined;
export function ensureGuest() {
  return (preparing ??= (async () => {
    const options = {
      baseUrl: location.origin,
      credentials: 'same-origin' as const,
      signal: AbortSignal.timeout(15000),
    };
    const prepared = await guestSessionPrepareGuest({ ...options, body: {} });
    if (!prepared.data?.ready) throw new Error('Разрешите cookie для сохранения Бронирования');
    const verified = await guestSessionVerifyGuest({
      ...options,
      signal: AbortSignal.timeout(15000),
    });
    if (!verified.data?.ready)
      throw new Error('Не удалось проверить cookie. Разрешите cookie и повторите выбор.');
  })().finally(() => {
    preparing = undefined;
  }));
}
