import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export function config() {
  const production = process.env.NODE_ENV === 'production';
  const databaseUrl =
    process.env.DATABASE_URL ??
    (production ? undefined : 'postgresql://postgres@127.0.0.1:5432/calendar');
  const railwayOrigin = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : undefined;
  const origin =
    process.env.APP_ORIGIN ?? railwayOrigin ?? (production ? undefined : 'http://127.0.0.1:5173');
  if (!databaseUrl || !origin) throw new Error('Задайте DATABASE_URL и APP_ORIGIN');
  return {
    databaseUrl,
    origin,
    trustProxy: process.env.TRUSTED_PROXIES?.split(',').filter(Boolean),
    // Demo mode: without an explicit DATABASE_URL the server starts without a
    // database, and therefore without a schema check at boot.
    schemaCheck: process.env.DATABASE_URL !== undefined,
  };
}
