import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const workflows = readdirSync('.github/workflows')
  .filter((name) => /\.ya?ml$/.test(name) && name !== 'hexlet-check.yml')
  .map((name) => `.github/workflows/${name}`);

const commands = [
  ['yarn', ['check:generated']],
  ['yarn', ['format:check']],
  ['yarn', ['lint']],
  ['yarn', ['typecheck']],
  ['yarn', ['check:unused']],
  ['yarn', ['check:architecture']],
  ['yarn', ['check:versions']],
  ['betterleaks', ['dir', '.', '--redact', '--config', '.betterleaks.toml']],
  [
    'jactionlint',
    ['--strict-exit', '--no-online', '--shellcheck=', ...workflows, '.github/dependabot.yml'],
  ],
  ['yarn', ['test']],
  ['yarn', ['build']],
  ['yarn', ['test:e2e']],
];

for (const [command, args] of commands) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
