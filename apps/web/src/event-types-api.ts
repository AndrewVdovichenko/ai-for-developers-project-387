import {
  createEventType,
  eventTypesGetEventType,
  eventTypesListEventTypes,
  getOwnerOperation,
} from '@calendar/api-client';
import type { CreateEventType } from '@calendar/api-client';

const options = () => ({
  baseUrl: window.location.origin,
  credentials: 'same-origin' as const,
  signal: AbortSignal.timeout(15_000),
});
export const listTypes = () => eventTypesListEventTypes(options());
export const readType = (id: string) => eventTypesGetEventType({ ...options(), path: { id } });
export const readCreation = (key: string) => getOwnerOperation({ ...options(), path: { key } });
export const sendCreation = (key: string, body: CreateEventType) =>
  createEventType({ ...options(), body, headers: { 'Idempotency-Key': key } });
