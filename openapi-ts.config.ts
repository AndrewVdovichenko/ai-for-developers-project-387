import { defineConfig } from '@hey-api/openapi-ts';
export default defineConfig({
  input: 'contracts/generated/openapi.yaml',
  output: {
    path: 'packages/api-client/src/generated',
    module: { extension: '.js' },
  },
  plugins: ['@hey-api/typescript', '@hey-api/sdk', '@hey-api/client-fetch'],
});
