import type pg from 'pg';
import { getEventType } from './event-types.js';

import { calculateSlots } from './slot-calculation.js';
import type { WeeklyDay } from './slot-calculation.js';

// Walk actual instants, rather than resolving ambiguous wall times. Each contiguous
// run belongs to one normalized working interval, including gaps/folds in its clock.
// The same construction can be filtered against shared Holds/Bookings later.
export async function getSlotAvailability(pool: pg.Pool, id: string, now: () => Date) {
  const type = await getEventType(pool, id);
  if (!type) return undefined;
  const settings = (
    await pool.query<{ timeZone: string | null; days: WeeklyDay[] }>(
      'SELECT time_zone AS "timeZone", days FROM calendar WHERE id = 1',
    )
  ).rows[0]!;
  const snapshot = now();
  const result = calculateSlots(settings, type.durationMinutes, snapshot);
  if (result.slots.length === 0) return result;
  const occupied = (
    await pool.query<{ startsAt: Date; endsAt: Date }>(
      `SELECT starts_at AS "startsAt", ends_at AS "endsAt" FROM holds
       WHERE state='active' AND expires_at>$1 AND ends_at>$2 AND starts_at<$3
       UNION ALL
       SELECT starts_at AS "startsAt", ends_at AS "endsAt" FROM bookings
       WHERE ends_at>$2 AND starts_at<$3`,
      [snapshot, result.windowStartsAt, result.windowEndsAt],
    )
  ).rows;
  return {
    ...result,
    slots: result.slots.filter(
      (slot) =>
        !occupied.some(
          (hold) =>
            hold.startsAt.getTime() < Date.parse(slot.endsAt) &&
            hold.endsAt.getTime() > Date.parse(slot.startsAt),
        ),
    ),
  };
}
