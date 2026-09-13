import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: { alias: { '@dai/content-contract': r('./packages/content-contract/src/index.ts'), '@dai/migrate-core': r('./packages/migrate-core/src/index.ts') } },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Two tiers run on their own configs and are excluded here: the proof tier needs the external
    // source truth (DAI_SOURCE_TRUTH_DIR, vitest.proof.config.ts), and the scale tier takes minutes
    // because it migrates a generated corpus (vitest.scale.config.ts).
    exclude: [...configDefaults.exclude, '**/proof/**', '**/scale/**'],
    environment: 'node',
  },
});
