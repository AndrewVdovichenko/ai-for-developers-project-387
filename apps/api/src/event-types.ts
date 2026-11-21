import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { isUuid, ownerSubject, runOperation } from './operations.js';

const columns = 'id, name, description, duration_minutes AS "durationMinutes"';
export async function listEventTypes(pool: pg.Pool) {
  return {
    items: (await pool.query(`SELECT ${columns} FROM event_types ORDER BY creation_order`)).rows,
  };
}
export async function getEventType(pool: pg.Pool, id: string) {
  if (!isUuid(id)) return undefined;
  return (await pool.query(`SELECT ${columns} FROM event_types WHERE id = $1`, [id])).rows[0];
}
export function createEventType(pool: pg.Pool, key: unknown, input: unknown) {
  const object = input && typeof input === 'object' && !Array.isArray(input) ? input : undefined;
  const fields: Record<string, unknown> = { ...object };
  if (typeof fields.name === 'string') fields.name = fields.name.trim();
  if (fields.description === undefined) fields.description = '';
  // Keep malformed models distinguishable instead of converting them into an empty object.
  const parameters = object ? fields : { invalidModel: input ?? null };
  return runOperation(
    pool,
    { subject: ownerSubject, key, action: 'createEventType', parameters },
    async (client) => {
      const fieldErrors: { field: string; code: string; message: string }[] = [];
      const invalid = (field: string, message: string) =>
        fieldErrors.push({ field, code: 'INVALID_VALUE', message });
      if (!object) invalid('body', 'Ожидается объект');
      for (const field of Object.keys(fields))
        if (!['name', 'description', 'durationMinutes'].includes(field))
          invalid(field, 'Неизвестное поле');
      if (
        typeof fields.name !== 'string' ||
        [...fields.name].length < 1 ||
        [...fields.name].length > 100
      )
        invalid('name', 'Название должно содержать от 1 до 100 символов');
      if (typeof fields.description !== 'string' || [...fields.description].length > 2000)
        invalid('description', 'Описание должно содержать до 2000 символов');
      for (const field of ['name', 'description'] as const)
        if (typeof fields[field] === 'string' && fields[field].includes('\u0000'))
          invalid(field, 'Символ U+0000 недопустим');
      if (
        typeof fields.durationMinutes !== 'number' ||
        !Number.isInteger(fields.durationMinutes) ||
        fields.durationMinutes < 1 ||
        fields.durationMinutes > 1440
      )
        invalid('durationMinutes', 'Длительность — целое число от 1 до 1440 минут');
      if (fieldErrors.length)
        return {
          status: 400,
          body: { code: 'VALIDATION_FAILED', message: 'Проверьте поля формы', fieldErrors },
        };
      const result = await client.query(
        `INSERT INTO event_types (id, name, description, duration_minutes) VALUES ($1, $2, $3, $4) RETURNING ${columns}`,
        [randomUUID(), fields.name, fields.description, fields.durationMinutes],
      );
      return { status: 201, body: { eventType: result.rows[0] } };
    },
  );
}
