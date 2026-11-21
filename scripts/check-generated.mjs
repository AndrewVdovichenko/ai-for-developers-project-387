import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directories = ['contracts/generated', 'packages/api-client/src/generated'];

async function snapshot() {
  const files = {};
  for (const directory of directories) {
    for (const name of (await readdir(directory, { recursive: true })).sort()) {
      const path = join(directory, name);
      // Generated trees contain directories as well as files.
      if ((await stat(path)).isFile()) files[path] = await readFile(path, 'utf8');
    }
  }
  return JSON.stringify(files);
}

const before = await snapshot();
const result = spawnSync('yarn', ['generate'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
if (before !== (await snapshot())) {
  console.error(
    'Генерируемые файлы устарели. Проверьте результат yarn generate и добавьте его в коммит.',
  );
  process.exitCode = 1;
}
