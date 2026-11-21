module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'web-cannot-import-api',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/api/' },
    },
    {
      name: 'packages-cannot-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'api-cannot-import-web',
      severity: 'error',
      from: { path: '^apps/api/' },
      to: { path: '^apps/web/' },
    },
    {
      name: 'no-production-dev-dependencies',
      severity: 'error',
      from: { path: '^(apps/[^/]+|packages/[^/]+)/src/' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: '(^|/)(dist|generated)/',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'apps/web/tsconfig.app.json' },
  },
};
