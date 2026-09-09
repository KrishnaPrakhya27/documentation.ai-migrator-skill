import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: { alias: { '@dai/content-contract': r('./packages/content-contract/src/index.ts'), '@dai/migrate-core': r('./packages/migrate-core/src/index.ts') } },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
