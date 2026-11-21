import { spawnSync } from 'node:child_process';

function run(args) {
  const result = spawnSync('container', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const command = process.argv[2];
if (command === 'start') {
  run(['system', 'start']);
  const existing = spawnSync('container', ['inspect', 'calendar-postgres'], { stdio: 'ignore' });
  if (existing.status === 0) run(['start', 'calendar-postgres']);
  else {
    const volume = spawnSync('container', ['volume', 'inspect', 'calendar-postgres'], {
      stdio: 'ignore',
    });
    if (volume.status !== 0) run(['volume', 'create', 'calendar-postgres']);
    run([
      'run',
      '-d',
      '--name',
      'calendar-postgres',
      '-p',
      '127.0.0.1:5432:5432',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=calendar',
      '-v',
      'calendar-postgres:/var/lib/postgresql',
      'postgres:18.7@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc',
    ]);
  }
} else if (command === 'stop') run(['stop', 'calendar-postgres']);
else if (command === 'status') run(['list', '-a']);
else throw new Error('Используйте start, stop или status');
