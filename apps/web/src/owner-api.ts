import {
  ownerSessionGetOwnerSession,
  ownerSessionLoginOwner,
  ownerSessionLogoutOwner,
} from '@calendar/api-client';

const options = () => ({
  baseUrl: window.location.origin,
  credentials: 'same-origin' as const,
  signal: AbortSignal.timeout(15_000),
});
export const readSession = () => ownerSessionGetOwnerSession(options());
export const signIn = (password: string) =>
  ownerSessionLoginOwner({ ...options(), body: { password } });
export const signOut = () => ownerSessionLogoutOwner(options());

export function ownerReturn(value: string | null) {
  if (!value?.startsWith('/owner/') || value.includes('\\')) return '/owner/event-types';
  const url = new URL(value, window.location.origin);
  return url.origin === window.location.origin &&
    ['/owner/event-types', '/owner/availability', '/owner/bookings'].includes(url.pathname)
    ? `${url.pathname}${url.search}${url.hash}`
    : '/owner/event-types';
}
