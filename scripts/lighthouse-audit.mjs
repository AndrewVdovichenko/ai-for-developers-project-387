#!/usr/bin/env node
// Спутник воркфлоу opencode-audit.yml.
//   demo-report <appUrl> <outPath> — синтетический Lighthouse-отчёт для
//     учебного прогона: пишется во временный каталог раннера, в репозиторий
//     не попадает. Пороги завышены так, чтобы падали ровно три метрики
//     (performance-score, LCP, TBT) — демонстрация дедупа без правки приложения.
//   findings <reportPath> <outPath> — детерминированный гейт находок:
//     проваленные бюджеты в findings.md, по строке на метрику, с отпечатком
//     <!-- audit: <page>:<metricKey> --> для сопоставления issue.
//     Пустой файл — находок нет. Агент не решает, что считать плохим.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BUDGETS = [
  {
    key: 'performance-score',
    audit: null,
    budget: 0.9,
    compare: 'lt',
    title: 'Performance score',
    unit: '',
    format: (v) => `${Math.round(v * 100)}/100`,
    budgetText: '<90/100',
  },
  {
    key: 'LCP',
    audit: 'largest-contentful-paint',
    budget: 2500,
    compare: 'gt',
    title: 'Largest Contentful Paint',
    unit: 'ms',
    format: (v) => `${Math.round(v)} ms`,
    budgetText: '>2500 ms',
  },
  {
    key: 'CLS',
    audit: 'cumulative-layout-shift',
    budget: 0.1,
    compare: 'gt',
    title: 'Cumulative Layout Shift',
    unit: '',
    format: (v) => v.toFixed(2),
    budgetText: '>0.10',
  },
  {
    key: 'TBT',
    audit: 'total-blocking-time',
    budget: 200,
    compare: 'gt',
    title: 'Total Blocking Time',
    unit: 'ms',
    format: (v) => `${Math.round(v)} ms`,
    budgetText: '>200 ms',
  },
];

const cmd = process.argv[2];
if (cmd === 'demo-report') {
  const [, , , appUrl, outPath] = process.argv;
  if (!appUrl || !outPath) {
    console.error('usage: lighthouse-audit.mjs demo-report <appUrl> <outPath>');
    process.exit(2);
  }
  const finalUrl = appUrl.endsWith('/') ? appUrl : `${appUrl}/`;
  const audit = (id, title, value, display) => ({
    id,
    title,
    numericValue: value,
    numericUnit: 'millisecond',
    displayValue: display,
  });
  const report = {
    lighthouseVersion: 'demo-12.8.2',
    fetchTime: new Date().toISOString(),
    finalUrl,
    requestedUrl: finalUrl,
    categories: { performance: { id: 'performance', score: 0.55 } },
    audits: {
      'largest-contentful-paint': audit(
        'largest-contentful-paint',
        'Largest Contentful Paint',
        4200,
        '4.2 s',
      ),
      'cumulative-layout-shift': audit(
        'cumulative-layout-shift',
        'Cumulative Layout Shift',
        0.05,
        '0.05',
      ),
      'total-blocking-time': audit('total-blocking-time', 'Total Blocking Time', 380, '380 ms'),
    },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report));
  console.log(`demo report written to ${outPath} (failed: performance-score, LCP, TBT)`);
} else if (cmd === 'findings') {
  const [, , , reportPath, outPath] = process.argv;
  if (!reportPath || !outPath) {
    console.error('usage: lighthouse-audit.mjs findings <reportPath> <outPath>');
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    console.error(`::error::report.json is missing or malformed: ${reportPath}`);
    process.exit(1);
  }
  let page = '/';
  try {
    page = new URL(report.finalUrl).pathname || '/';
  } catch {
    // finalUrl может быть относительным или отсутствовать — остаётся "/".
  }
  const rows = [];
  for (const b of BUDGETS) {
    const value =
      b.audit === null
        ? report?.categories?.performance?.score
        : report?.audits?.[b.audit]?.numericValue;
    // Детерминированный гейт не догадывается: отсутствие значения —
    // сломанный вход, а не «пройдено». Красный прогон без публикации.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      console.error(
        `::error::report lacks a finite ${b.key} value — malformed input, refusing to gate`,
      );
      process.exit(1);
    }
    const failed = b.compare === 'lt' ? value < b.budget : value > b.budget;
    if (!failed) continue;
    const display = report?.audits?.[b.audit]?.displayValue ?? b.format(value);
    rows.push(
      [
        `- метрика=${b.key}`,
        `title="${b.title}"`,
        `value=${display}`,
        `budget=${b.budgetText}`,
        `отпечаток=<!-- audit: ${page}:${b.key} -->`,
      ].join(' | '),
    );
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const header = `Страница: ${page} (снят ${report.fetchTime ?? 'время неизвестно'})\n`;
  writeFileSync(outPath, rows.length > 0 ? header + rows.join('\n') + '\n' : '');
  console.log(rows.length > 0 ? `findings: ${rows.length}` : 'findings: none');
} else {
  console.error('usage: lighthouse-audit.mjs <demo-report|findings> ...');
  process.exit(2);
}
