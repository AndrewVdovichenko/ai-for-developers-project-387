type Interval = { startMinute: number; endMinute: number };
export type WeeklyDay = { weekday: number; intervals: Interval[] };
const minute = 60_000;
const day = 1440 * minute;

// Mutating Hold/Booking transactions reuse this with settings read by their
// transaction client and the authoritative decision time after locking.
export function calculateSlots(
  settings: { timeZone: string | null; days: WeeklyDay[] },
  durationMinutes: number,
  serverNow: Date,
) {
  const empty = {
    configured: settings.timeZone !== null,
    serverNow: serverNow.toISOString(),
    timeZone: settings.timeZone,
    windowStartsAt: null,
    windowEndsAt: null,
    slots: [],
  };
  if (!settings.timeZone) return empty;
  const local = localClock(settings.timeZone);
  const today = local(serverNow.getTime()).date;
  const after = today + 14 * day;
  let windowStart: number | undefined;
  let windowEnd: number | undefined;
  const runs: { start: number; end: number; candidates: number[]; key: string }[] = [];
  let previous: (typeof runs)[number] | undefined;
  // IANA offsets fit within this padding, even when a whole local date is skipped.
  for (let stamp = today - 2 * day; stamp <= after + 2 * day; stamp += minute) {
    const current = local(stamp);
    if (current.date < today) continue;
    if (windowStart === undefined) windowStart = stamp;
    if (current.date >= after) {
      windowEnd = stamp;
      break;
    }
    const working = workingPosition(settings.days, current);
    if (!working) {
      previous = undefined;
      continue;
    }
    const { key, startMinute } = working;
    if (!previous || previous.key !== key || previous.end !== stamp) {
      previous = { start: stamp, end: stamp, candidates: [], key };
      runs.push(previous);
    }
    previous.end = stamp + minute;
    if ((current.clock - startMinute) % 15 === 0 && stamp >= serverNow.getTime())
      previous.candidates.push(stamp);
  }
  const duration = durationMinutes * minute;
  const slots = runs.flatMap((run) =>
    run.candidates
      .filter((start) => start + duration <= run.end && start + duration <= windowEnd!)
      .map((start) => ({
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + duration).toISOString(),
      })),
  );
  return {
    ...empty,
    windowStartsAt: new Date(windowStart!).toISOString(),
    windowEndsAt: new Date(windowEnd!).toISOString(),
    slots,
  };
}

function localClock(timeZone: string) {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  function local(stamp: number) {
    const parts = Object.fromEntries(
      format.formatToParts(stamp).map((part) => [part.type, part.value]),
    );
    return {
      date: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)),
      clock: Number(parts.hour) * 60 + Number(parts.minute),
    };
  }
  return local;
}
// Same continuous local-date/working-interval runs as slot generation, without
// the public booking window or the 15-minute start grid.
export function intervalFitsWorkingHours(
  settings: { timeZone: string; days: WeeklyDay[] },
  startsAt: Date,
  endsAt: Date,
) {
  const local = localClock(settings.timeZone);
  let key: string | undefined;
  for (
    let stamp = Math.floor(startsAt.getTime() / minute) * minute;
    stamp < endsAt.getTime();
    stamp += minute
  ) {
    const current = local(stamp);
    const working = workingPosition(settings.days, current);
    if (!working) return false;
    const nextKey = working.key;
    if (key !== undefined && key !== nextKey) return false;
    key = nextKey;
  }
  return startsAt < endsAt;
}

function workingPosition(days: WeeklyDay[], current: { date: number; clock: number }) {
  const weekday = new Date(current.date).getUTCDay() || 7;
  const intervals = days.find((item) => item.weekday === weekday)!.intervals;
  const index = intervals.findIndex(
    (interval) => current.clock >= interval.startMinute && current.clock < interval.endMinute,
  );
  return index < 0
    ? undefined
    : { key: `${current.date}:${index}`, startMinute: intervals[index]!.startMinute };
}
