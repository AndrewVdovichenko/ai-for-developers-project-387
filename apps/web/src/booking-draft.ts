import { operationStorage } from './operation-storage';
import type { ConfirmBooking } from '@calendar/api-client';
export type ConfirmationContext = {
  key: string;
  action?: 'confirm-hold';
  attempt?: number;
  fingerprint: string;
  holdId: string;
  bookingId?: string;
  body?: ConfirmBooking;
};
export const confirmationStorage = () =>
  operationStorage<ConfirmationContext>(
    'guest-confirmation',
    'guest_confirmation',
    ({ key, action, attempt, fingerprint, holdId, bookingId }) => ({
      key,
      action,
      attempt,
      fingerprint,
      holdId,
      bookingId,
    }),
  );
const draftKey = 'guest-booking-draft';
type Draft = { revision: number; body: ConfirmBooking };
let memory: Draft = { revision: 0, body: { guestName: '', guestEmail: '' } };
function latestDraft() {
  let latest = memory;
  for (const storage of [() => localStorage, () => sessionStorage])
    try {
      const value = storage().getItem(draftKey);
      if (value) {
        const parsed = JSON.parse(value) as Draft & ConfirmBooking;
        const draft = parsed.body ? parsed : { revision: 0, body: parsed };
        if (draft.revision >= latest.revision) latest = draft;
      }
    } catch {
      /* Next available store. */
    }
  return latest;
}
export function loadBookingDraft() {
  return latestDraft().body;
}
export function saveBookingDraft(body: ConfirmBooking) {
  memory = { revision: Math.max(Date.now(), latestDraft().revision + 1), body };
  for (const storage of [() => localStorage, () => sessionStorage])
    try {
      storage().setItem(draftKey, JSON.stringify(memory));
      if (storage().getItem(draftKey) === JSON.stringify(memory)) return;
    } catch {
      /* Form is never put in a cookie. */
    }
}
export function clearBookingDraft() {
  memory = {
    revision: Math.max(Date.now(), latestDraft().revision + 1),
    body: { guestName: '', guestEmail: '' },
  };
  for (const storage of [() => localStorage, () => sessionStorage])
    try {
      storage().setItem(draftKey, JSON.stringify(memory));
    } catch {
      /* The newer empty draft in the fallback store supersedes stale copies. */
    }
}
