import { configDefaults, defineConfig } from 'vitest/config';
import unitConfig from './vitest.config.ts';

/**
 * Scale tier: the whole pipeline over a generated corpus, measuring what a large migration costs
 * in time and in memory. Excluded from `npm test` because a five-thousand-page run takes minutes;
 * run with `npm run test:scale`, and set DAI_SCALE_PAGES to change the corpus size.
 */
export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    include: ['packages/*/test/scale/**/*.scale.test.ts'],
    exclude: [...configDefaults.exclude],
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
