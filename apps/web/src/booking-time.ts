export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export function bookingTime(instant: string, timeZone = browserTimeZone()) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'longOffset',
    hourCycle: 'h23',
  }).format(new Date(instant));
}
