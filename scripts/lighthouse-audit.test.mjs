#!/usr/bin/env node
// Тест companion-скрипта opencode-audit и синхронности его контрактов.
// Запускается через node --test из scripts/check.mjs. Покрывает:
//   1. demo-report + findings: ровно три ожидаемые находки с отпечатками;
//   2. чистый отчёт: пустой findings.md (нет ложных находок);
//   3. неполный отчёт: сломанный вход краснеет, а не озеленяется;
//   4. формат отпечатка: регулярки из workflow-yml совпадают с тем, что
//      реально генерирует скрипт, и не ловят литералы-плейсхолдеры.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'lighthouse-audit.mjs');
const workflow = resolve(here, '..', '.github', 'workflows', 'opencode-audit.yml');
const tmp = mkdtempSync(join(tmpdir(), 'lh-audit-'));

function run(...args) {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function findingsOf(report) {
  const reportPath = join(tmp, 'report.json');
  const outPath = join(tmp, 'findings.md');
  writeFileSync(reportPath, JSON.stringify(report));
  run('findings', reportPath, outPath);
  return readFileSync(outPath, 'utf8');
}

test('demo-report и findings: ровно три ожидаемые находки', () => {
  const reportPath = join(tmp, 'demo.json');
  run('demo-report', 'https://calendar-386-production.up.railway.app', reportPath);
  const findings = findingsOf(JSON.parse(readFileSync(reportPath, 'utf8')));
  const lines = findings.split('\n').filter((l) => l.startsWith('- метрика='));
  assert.equal(lines.length, 3);
  const keys = lines.map((l) => l.match(/метрика=(\S+)/)[1]);
  assert.deepEqual(keys, ['performance-score', 'LCP', 'TBT']);
  assert.match(findings, /отпечаток=<!-- audit: \/:LCP -->/);
});

test('чистый отчёт даёт пустой findings.md', () => {
  const findings = findingsOf({
    finalUrl: 'https://calendar-386-production.up.railway.app/',
    fetchTime: new Date().toISOString(),
    categories: { performance: { score: 0.95 } },
    audits: {
      'largest-contentful-paint': { numericValue: 1800 },
      'cumulative-layout-shift': { numericValue: 0.05 },
      'total-blocking-time': { numericValue: 90 },
    },
  });
  assert.equal(findings, '');
});

test('неполный отчёт — сломанный вход, гейт краснеет', () => {
  const reportPath = join(tmp, 'broken.json');
  const outPath = join(tmp, 'broken-findings.md');
  writeFileSync(
    reportPath,
    JSON.stringify({
      finalUrl: 'https://x/',
      fetchTime: new Date().toISOString(),
      categories: { performance: { score: 0.95 } },
      audits: { 'largest-contentful-paint': { numericValue: 1800 } },
    }),
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, 'findings', reportPath, outPath], { stdio: 'pipe' }),
    (err) => err.status === 1,
  );
});

test('формат отпечатка синхронен с регулярками workflow-yml', () => {
  const yml = readFileSync(workflow, 'utf8');
  const testSrc = [...yml.matchAll(/test\("([^"]+)"\)/g)]
    .map((m) => m[1])
    .find((s) => s.includes('audit:'));
  const captureSrc = [...yml.matchAll(/capture\("([^"]+)"\)/g)]
    .map((m) => m[1])
    .find((s) => s.includes('audit:'));
  assert.ok(testSrc, 'jq test(...) с шаблоном отпечатка должен быть в workflow');
  assert.ok(captureSrc, 'jq capture(...) с шаблоном отпечатка должен быть в workflow');

  const testRe = new RegExp(testSrc);
  const captureRe = new RegExp(captureSrc);

  // Скрипт реально генерирует строку вида отпечаток=<!-- audit: /:LCP -->.
  const generated = run('findings', join(tmp, 'demo.json'), join(tmp, 'sync-findings.md'));
  assert.equal(generated.trim(), 'findings: 3');
  const findings = readFileSync(join(tmp, 'sync-findings.md'), 'utf8');
  const fingerprints = [...findings.matchAll(/отпечаток=(<!-- audit: \S+ -->)/g)].map((m) => m[1]);
  assert.equal(fingerprints.length, 3);
  for (const fp of fingerprints) {
    assert.ok(testRe.test(fp), `test(...) не принимает сгенерированный отпечаток: ${fp}`);
    const match = captureRe.exec(fp);
    assert.ok(match?.groups?.f, `capture(...) не извлекает fingerprint: ${fp}`);
  }

  // Плейсхолдеры из шаблонного текста не должны матчиться.
  assert.equal(testRe.test('<!-- audit: <страница>:<метрика> -->'), false);
  assert.equal(testRe.test('<!-- audit: ... -->'), false);
});
