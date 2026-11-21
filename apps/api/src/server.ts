import { createApp } from './app.js';
import { createPool } from './database.js';
import { config } from './config.js';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
const settings = config();
const pool = createPool(settings.databaseUrl);
const app = createApp({
  pool,
  origin: settings.origin,
  trustProxy: settings.trustProxy,
  schemaCheck: settings.schemaCheck,
});
if (process.env.SERVE_STATIC === '1') {
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api') && !request.url.includes('.'))
      return reply.sendFile('index.html');
    return reply.code(404).send({ code: 'NOT_FOUND', message: 'Ресурс не найден' });
  });
}
app.addHook('onClose', () => pool.end());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
try {
  await app.listen({
    host: process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: Number(process.env.PORT ?? 3000),
  });
} catch {
  app.log.error('API не запущен: проверьте доступность БД и совместимость миграций');
  await app.close();
  process.exitCode = 1;
}
