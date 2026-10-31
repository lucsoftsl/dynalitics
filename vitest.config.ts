import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests run everywhere. Integration tests (real databases in Docker) live under
// packages/*/test/integration and are only included when DYNALITICS_INTEGRATION=1.
const includeIntegration = process.env['DYNALITICS_INTEGRATION'] === '1';

export default defineConfig({
  // Adapter packages import 'dynalitics/adapter'; tests must share ONE copy of it with the core sources.
  resolve: {
    alias: {
      'dynalitics/adapter': fileURLToPath(
        new URL('./packages/dynalitics/src/adapter.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    exclude: includeIntegration ? [] : ['**/test/integration/**', '**/node_modules/**'],
    passWithNoTests: true,
    testTimeout: includeIntegration ? 60_000 : 5_000,
    hookTimeout: includeIntegration ? 120_000 : 10_000,
    fileParallelism: !includeIntegration,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
