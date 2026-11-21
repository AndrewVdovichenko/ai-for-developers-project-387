import type { AvailabilitySettings, SaveAvailability } from '@calendar/api-client';
import { operationStorage } from './operation-storage';
export type SaveContext = {
  key: string;
  fingerprint: string;
  revision: number;
  confirmationToken?: string;
  parameters?: SaveAvailability;
};
export const saveStorage = operationStorage<SaveContext>(
  'owner-availability-operation',
  'owner_availability_operation',
  ({ key, fingerprint, revision, confirmationToken }) => ({
    key,
    fingerprint,
    revision,
    confirmationToken,
  }),
);
export type Draft = {
  revision: number;
  timeZone: string;
  days: { weekday: number; intervals: { start: string; end: string }[] }[];
};
// Unsent changes survive routing through login, only in this tab's memory.
export const availabilityDraft: { current?: Draft } = {};
export const time = (minute: number) =>
  `${Math.floor(minute / 60)
    .toString()
    .padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`;
export function draftFrom(settings: AvailabilitySettings): Draft {
  return {
    revision: settings.revision,
    timeZone: settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: settings.days.map((day) => ({
      weekday: day.weekday,
      intervals: day.intervals.map((interval) => ({
        start: time(interval.startMinute),
        end: time(interval.endMinute),
      })),
    })),
  };
}
export function parametersFrom(draft: Draft): SaveAvailability {
  function minute(value: string) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(value))
      throw new Error('Введите часы в формате ЧЧ:ММ; 24:00 допустимо только для окончания');
    const [hours, minutes] = value.split(':').map(Number);
    return hours! * 60 + minutes!;
  }
  return {
    revision: draft.revision,
    timeZone: draft.timeZone,
    days: draft.days.map((day) => {
      const intervals = day.intervals
        .map((interval) => ({
          startMinute: minute(interval.start),
          endMinute: minute(interval.end),
        }))
        .sort((a, b) => a.startMinute - b.startMinute);
      const merged: SaveAvailability['days'][number]['intervals'] = [];
      for (const interval of intervals) {
        if (interval.startMinute >= 1440 || interval.endMinute <= interval.startMinute)
          throw new Error(
            'Конец интервала должен быть позже начала; ночные часы разделите по дням',
          );
        const previous = merged.at(-1);
        if (previous && previous.endMinute > interval.startMinute)
          throw new Error('Интервалы не должны пересекаться');
        if (previous?.endMinute === interval.startMinute) previous.endMinute = interval.endMinute;
        else merged.push(interval);
      }
      return { weekday: day.weekday, intervals: merged };
    }),
  };
}
export async function saveFingerprint(parameters: SaveAvailability) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(parameters)),
  );
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
