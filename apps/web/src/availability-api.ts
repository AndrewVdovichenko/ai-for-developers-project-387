import {
  ownerAvailabilityGetAvailability,
  ownerAvailabilityPreviewAvailability,
  ownerAvailabilitySaveAvailability,
  getOwnerOperation,
} from '@calendar/api-client';
import type { SaveAvailability } from '@calendar/api-client';
const options = () => ({
  baseUrl: window.location.origin,
  credentials: 'same-origin' as const,
  signal: AbortSignal.timeout(15_000),
});
export const readAvailability = () => ownerAvailabilityGetAvailability(options());
export const sendAvailability = (key: string, body: SaveAvailability) =>
  ownerAvailabilitySaveAvailability({ ...options(), body, headers: { 'Idempotency-Key': key } });
export const readSave = (key: string) => getOwnerOperation({ ...options(), path: { key } });

export const previewAvailability = (body: SaveAvailability) =>
  ownerAvailabilityPreviewAvailability({ ...options(), body });
