import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import { ownerSessionGetOwnerSession, ownerSessionLoginOwner } from '@calendar/api-client';
import { testDatabase } from './database.js';
import { createApp } from '../src/app.js';

function command(databaseUrl: string, binary: string, args: string[], input?: string) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(binary, args, {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        APP_ORIGIN: 'http://localhost:5173',
        PORT: '0',
      },
      signal: AbortSignal.timeout(20_000),
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}
const cli = ['--import', 'tsx', 'apps/api/src/cli.ts'];

test('реальные процессы миграций и API отвергают несовместимую/недоступную БД', async () => {
  const db = await testDatabase();
  try {
    const missing = await command(db.url, process.execPath, [
      '--import',
      'tsx',
      'apps/api/src/server.ts',
    ]);
    expect(missing.code).toBe(1);
    expect(missing.output).not.toContain('Server listening');
    for (let i = 0; i < 2; i++)
      expect((await command(db.url, process.execPath, [...cli, 'migrate'])).code).toBe(0);
    await db.pool.query("UPDATE schema_migrations SET checksum = 'incompatible'");
    const incompatible = await command(db.url, process.execPath, [
      '--import',
      'tsx',
      'apps/api/src/server.ts',
    ]);
    expect(incompatible.code).toBe(1);
    expect(incompatible.output).not.toContain('Server listening');
    expect((await command(db.url, process.execPath, [...cli, 'migrate'])).code).toBe(1);
    expect(
      (
        await command('postgresql://postgres@127.0.0.1:1/missing', process.execPath, [
          '--import',
          'tsx',
          'apps/api/src/server.ts',
        ])
      ).code,
    ).toBe(1);
  } finally {
    await db.close();
  }
});

test('команда пароля скрывает Unicode-ввод, проверяет длину/повтор и отзывает сессии', async () => {
  const db = await testDatabase();
  await db.migrate();
  const origin = 'http://localhost:5173';
  const app = createApp({ pool: db.pool, origin });
  async function passwordCommand(first: string, second: string) {
    const result = await command(
      db.url,
      'python3',
      ['apps/api/test/terminal.py', process.execPath, ...cli, 'password'],
      JSON.stringify([first, second]),
    );
    expect(result.code).toBe(0);
    const terminal = JSON.parse(result.output) as {
      exitCode: number;
      hidden: boolean;
      inputsSent: number;
      output: string;
    };
    expect(terminal.hidden).toBe(true);
    expect(terminal.inputsSent).toBe(2);
    expect(terminal.output).not.toContain(first);
    expect(terminal.output).not.toContain(second);
    return terminal.exitCode;
  }
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const value = '  Пароль 🔑 кириллица  ';
    expect(await passwordCommand('🔑'.repeat(11), '🔑'.repeat(11))).toBe(1);
    expect((await ownerSessionGetOwnerSession({ baseUrl })).data?.configured).toBe(false);
    expect(await passwordCommand(value, value)).toBe(0);
    const login = () =>
      ownerSessionLoginOwner({ baseUrl, body: { password: value }, headers: { Origin: origin } });
    const Cookie = (await login()).response!.headers.get('set-cookie')!.split(';')[0]!;
    expect(await passwordCommand('несовпадающий первый', 'несовпадающий второй')).toBe(1);
    expect(
      (await ownerSessionGetOwnerSession({ baseUrl, headers: { Cookie } })).data?.authenticated,
    ).toBe(true);
    const replacement = '🔑'.repeat(12);
    expect(await passwordCommand(replacement, replacement)).toBe(0);
    expect(
      (await ownerSessionGetOwnerSession({ baseUrl, headers: { Cookie } })).data?.authenticated,
    ).toBe(false);
    expect((await login()).error?.code).toBe('INVALID_PASSWORD');
    expect(
      (
        await ownerSessionLoginOwner({
          baseUrl,
          body: { password: replacement },
          headers: { Origin: origin },
        })
      ).response!.status,
    ).toBe(200);
  } finally {
    await app.close();
    await db.close();
  }
}, 30_000);
