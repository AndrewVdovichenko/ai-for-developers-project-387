import { getStatus } from '@calendar/api-client';
import { expect, test } from 'vitest';
import { createApp } from '../src/app.js';
import { testDatabase } from './database.js';
test('сервер запускается и отвечает 200 на GET /health через SDK', async () => {
  const db = await testDatabase();
  await db.migrate();
  const app = createApp({ pool: db.pool, origin: 'http://127.0.0.1:5173' });
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const { response } = await getStatus({ baseUrl, throwOnError: true });
    expect(response.status).toBe(200);
  } finally {
    await app.close();
    await db.close();
  }
});
