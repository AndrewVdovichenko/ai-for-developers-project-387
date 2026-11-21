import { emitKeypressEvents } from 'node:readline';
import { createPool } from './database.js';
import { migrate, checkSchema } from './migrations.js';
import { resetPassword } from './access.js';
import { config } from './config.js';

async function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Для ввода пароля нужен терминал');
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      const chars: string[] = [];
      function onKey(
        text: string | undefined,
        key: { name?: string; ctrl?: boolean; meta?: boolean },
      ) {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
          cleanup();
          reject(new Error('Ввод отменён'));
        } else if (key.name === 'return' || key.name === 'enter') {
          cleanup();
          resolve(chars.join(''));
        } else if (key.name === 'backspace') chars.pop();
        else if (text && !key.ctrl && !key.meta && !text.includes('\u001b')) chars.push(...text);
      }
      function cleanup() {
        process.stdin.removeListener('keypress', onKey);
      }
      process.stdin.on('keypress', onKey);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
  }
}

const pool = createPool(config().databaseUrl);
try {
  if (process.argv[2] === 'migrate') {
    await migrate(pool);
    console.log('Миграции применены');
  } else if (process.argv[2] === 'password' && process.argv.length === 3) {
    await checkSchema(pool);
    const password = await hiddenPassword('Новый пароль: ');
    const confirmation = await hiddenPassword('Повторите пароль: ');
    await resetPassword(pool, password, confirmation);
    console.log('Пароль сохранён. Все сессии отозваны.');
  } else throw new Error('Используйте migrate или password без аргументов');
} catch {
  console.error(
    'Команда не выполнена. Проверьте БД, миграции и совпадение паролей длиной от 12 символов.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
