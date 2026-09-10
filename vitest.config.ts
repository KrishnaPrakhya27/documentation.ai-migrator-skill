import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: { alias: { '@dai/content-contract': r('./packages/content-contract/src/index.ts'), '@dai/migrate-core': r('./packages/migrate-core/src/index.ts') } },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The proof tier needs the external source truth (DAI_SOURCE_TRUTH_DIR); it runs through vitest.proof.config.ts.
    exclude: [...configDefaults.exclude, '**/proof/**'],
    environment: 'node',
  },
});
