import { confirmHold, getGuestOperation } from '@calendar/api-client';
import type { ApiError, ConfirmBooking, OperationResponse } from '@calendar/api-client';
import { clearBookingDraft, confirmationStorage } from './booking-draft';
import type { ConfirmationContext } from './booking-draft';

async function confirmationFingerprint(holdId: string, body: ConfirmBooking) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([holdId, body])),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

type Snapshot = {
  locked: boolean;
  sending: boolean;
  needsInput: boolean;
  message: string;
  error?: ApiError;
  bookingId?: string;
};

// One controller per tab survives React remounts and serializes GET + same-key replay.
class ConfirmationRecovery {
  private storage = confirmationStorage();
  private context = this.storage.load();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  // Replies of an abandoned conversation must never move the state of the current one.
  private conversation = 0;
  private snapshot: Snapshot = {
    locked: !!this.context && !this.context.bookingId,
    sending: false,
    needsInput: false,
    message: '',
    bookingId: this.context?.bookingId,
  };
  getSnapshot = () => this.snapshot;
  private update(value: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...value };
    for (const listener of this.listeners) listener();
  }
  private connection = () => {
    clearTimeout(this.timer);
    if (!this.context || this.context.bookingId) return;
    if (!navigator.onLine) {
      this.update({ message: 'Нет соединения. Продолжим после восстановления связи' });
      return;
    }
    this.update({ message: 'Уточняем результат…' });
    this.schedule();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      window.addEventListener('online', this.connection);
      window.addEventListener('offline', this.connection);
      // A new explicit booking intent can clear the previous known success.
      if (!this.running) this.context = this.storage.load();
      this.update({
        locked: !!this.context && !this.context.bookingId,
        bookingId: this.context?.bookingId,
      });
      if (this.context && !this.context.bookingId) {
        if (navigator.onLine) void this.recover();
        else this.connection();
      }
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearTimeout(this.timer);
        window.removeEventListener('online', this.connection);
        window.removeEventListener('offline', this.connection);
      }
    };
  };
  // An explicit booking intent outweighs the previous conversation with the server: nothing of it
  // may survive in the snapshot, because a known booking id sends the guest back to that booking.
  reset() {
    this.conversation++;
    clearTimeout(this.timer);
    this.running = false;
    this.context = undefined;
    this.storage.clear();
    this.update({
      locked: false,
      sending: false,
      needsInput: false,
      message: '',
      error: undefined,
      bookingId: undefined,
    });
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.context || this.context.bookingId || !this.listeners.size || !navigator.onLine)
      return;
    const attempt = this.context.attempt ?? 0;
    this.timer = setTimeout(
      () => void this.recover(),
      [1000, 2000, 4000, 10000][Math.min(attempt, 3)],
    );
  }
  private complete(response: OperationResponse) {
    if (!this.context) return;
    if (response.status === 200 && 'booking' in response.body) {
      this.context = {
        key: this.context.key,
        action: 'confirm-hold',
        fingerprint: this.context.fingerprint,
        holdId: this.context.holdId,
        bookingId: response.body.booking.id,
      };
      this.storage.persist(this.context);
      clearBookingDraft();
      this.update({
        locked: false,
        sending: false,
        needsInput: false,
        message: '',
        bookingId: this.context.bookingId,
      });
      return;
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 401) {
      this.storage.clear();
      this.context = undefined;
      this.update({
        locked: false,
        sending: false,
        needsInput: false,
        message: (response.body as ApiError).message,
        error: response.body as ApiError,
      });
      window.dispatchEvent(new Event('calendar:availability-conflict'));
      return;
    }
    throw new Error('Unknown result');
  }
  private async replay(context: ConfirmationContext, conversation: number) {
    if (!context.body) return;
    const result = await confirmHold({
      baseUrl: location.origin,
      path: { id: context.holdId },
      headers: { 'Idempotency-Key': context.key },
      body: context.body,
      signal: AbortSignal.timeout(15000),
    });
    if (conversation !== this.conversation) return;
    if (result.data) this.complete({ status: 200, body: result.data });
    else if (result.error && result.response)
      this.complete({ status: result.response.status, body: result.error });
    else throw new Error('Unknown result');
  }
  private async recover() {
    if (this.running || !this.context || this.context.bookingId || !navigator.onLine) return;
    const conversation = this.conversation;
    this.running = true;
    this.update({ message: 'Уточняем результат…' });
    const context = this.context;
    try {
      const result = await getGuestOperation({
        baseUrl: location.origin,
        path: { key: context.key },
        signal: AbortSignal.timeout(15000),
      });
      if (conversation !== this.conversation) return;
      if (result.data?.state === 'completed') this.complete(result.data.response);
      else if (result.data?.state === 'unknown') {
        if (context.body && navigator.onLine) await this.replay(context, conversation);
        else if (!context.body)
          this.update({
            needsInput: true,
            message:
              'Уточняем результат… Введите прежние имя и email, чтобы продолжить подтверждение.',
          });
      }
    } catch {
      // A timeout or 503 never means that the server cancelled or refused the operation.
    } finally {
      if (conversation === this.conversation) {
        this.running = false;
        if (this.context && !this.context.bookingId) {
          this.context.attempt = (this.context.attempt ?? 0) + 1;
          this.storage.persist(this.context);
          if (!navigator.onLine) this.connection();
          this.schedule();
        }
      }
    }
  }
  async submit(holdId: string, body: ConfirmBooking) {
    if (this.running || (this.context && !this.snapshot.needsInput)) return;
    const conversation = this.conversation;
    this.running = true;
    this.update({ sending: true, error: undefined, message: '' });
    try {
      const fingerprint = await confirmationFingerprint(this.context?.holdId ?? holdId, body);
      if (this.context && this.context.fingerprint !== fingerprint) {
        this.update({
          message:
            'Нужны прежние имя и email. Изменённые данные нельзя отправить, пока исход неизвестен.',
        });
        return;
      }
      const context: ConfirmationContext = this.context
        ? { ...this.context, body }
        : {
            key: crypto.randomUUID(),
            action: 'confirm-hold',
            holdId,
            body,
            fingerprint,
            attempt: 0,
          };
      if (!this.storage.persist(context)) {
        this.update({
          message: 'Не удалось сохранить ключ операции. Разрешите хранилище браузера и cookie.',
        });
        return;
      }
      this.context = context;
      this.update({ locked: true, needsInput: false });
      if (navigator.onLine) await this.replay(context, conversation);
    } catch {
      // Persisted context remains authoritative until the original result is known.
    } finally {
      if (conversation === this.conversation) {
        this.running = false;
        this.update({ sending: false });
        if (this.context && !this.context.bookingId) {
          if (!this.snapshot.needsInput || !navigator.onLine)
            this.update({
              message: navigator.onLine
                ? 'Уточняем результат…'
                : 'Нет соединения. Продолжим после восстановления связи',
            });
          this.schedule();
        }
      }
    }
  }
}
let recovery: ConfirmationRecovery | undefined;
export function confirmationRecovery() {
  return (recovery ??= new ConfirmationRecovery());
}
