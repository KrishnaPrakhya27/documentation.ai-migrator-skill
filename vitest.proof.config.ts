import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import unitConfig from './vitest.config.ts';

/**
 * Proof tier: exactness tests against the externally stored raw source of a
 * real site, reached only through DAI_SOURCE_TRUTH_DIR. Excluded from
 * `npm test`; run with `npm run test:proof`. The setup file resolves the truth
 * directory before any test so a missing or incomplete directory fails the run
 * immediately instead of skipping it.
 */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    include: ['packages/*/test/proof/**/*.proof.test.ts'],
    exclude: [...configDefaults.exclude],
    setupFiles: [r('./packages/migrate-core/test/proof/setup.ts')],
  },
});
