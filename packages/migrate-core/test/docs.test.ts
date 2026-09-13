/**
 * Documentation that contradicts the code is worse than none: an operator acts on
 * it. These tests fail when the shipped text drifts from what the code does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXACT_FAMILY_GATE_IDS, REQUIRED_RELEASE_GATE_IDS } from '../src/verify/gates.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

describe('operator documentation', () => {
  it('lists every required gate id in the verify skill', () => {
    const skill = read('skills/verify/SKILL.md');
    for (const id of REQUIRED_RELEASE_GATE_IDS) expect(skill, `skills/verify/SKILL.md does not mention gate ${id}`).toContain(`\`${id}\``);
    for (const id of EXACT_FAMILY_GATE_IDS) expect(skill, `the exact-fidelity family member ${id} is undocumented`).toContain(id);
  });

  it('states the gate count the code actually has', () => {
    const status = read('docs/STATUS.md');
    expect(status, 'docs/STATUS.md states a gate count that is not the code’s').toContain(`${REQUIRED_RELEASE_GATE_IDS.length} release gates`);
  });

  it('requires the immutable release certificate in every platform migration workflow', () => {
    for (const platform of ['generic', 'mintlify', 'gitbook', 'readme', 'document360']) {
      expect(read(`skills/migrate-${platform}/SKILL.md`), `${platform} workflow omits the release certificate command`).toContain('`release`');
    }
  });

  it('keeps a README that explains the fidelity modes and the two test tiers', () => {
    const readme = read('README.md');
    expect(readme.length).toBeGreaterThan(1000);
    for (const phrase of ['--fidelity', 'exact', 'permissive', 'npm run test:proof', 'DAI_SOURCE_TRUTH_DIR']) {
      expect(readme, `README.md does not explain ${phrase}`).toContain(phrase);
    }
  });

  it('documents exact mode, its stop conditions and the navigation sources where an operator will look', () => {
    const docs = [read('README.md'), read('docs/STATUS.md'), read('skills/verify/SKILL.md')].join('\n');
    for (const phrase of ['block-exclusions.yaml', 'llms.txt', 'unlisted', 'preview-routes.json', 'not-run']) {
      expect(docs, `no operator document mentions ${phrase}`).toContain(phrase);
    }
  });

  it('carries no customer or demo site content anywhere in the repository', () => {
    // The platform's own host suffix (`.mintlify.site`) is knowledge the profile must carry; what may not
    // appear is a specific customer's site slug or their page content.
    const banned = /dragon\s?ball|demo-6782454b|goku|vegeta|saiyan/i;
    const skip = new Set(['node_modules', '.git', 'dist', 'coverage']);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const relative = join(dir, entry.name);
        if (entry.isDirectory()) { walk(relative); continue; }
        if (!/\.(ts|tsx|md|json|ya?ml)$/.test(entry.name)) continue;
        if (relative.includes('tsconfig.tsbuildinfo') || relative.includes('package-lock.json')) continue;
        const text = readFileSync(join(repoRoot, relative), 'utf8');
        // The fixture-fetcher and the proof tests name the saved site's host: they read it from
        // outside the repository and must be able to say which origin they serve.
        const allowed = relative.startsWith(join('packages', 'migrate-core', 'test', 'helpers'))
          || relative.includes(join('test', 'proof'))
          || relative.endsWith(join('test', 'docs.test.ts'));
        if (banned.test(text) && !allowed) offenders.push(relative);
      }
    };
    walk('.');
    expect(offenders, `demo-site content must live outside the plugin repository: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps the workspace layout the skills describe', () => {
    expect(existsSync(join(repoRoot, 'vitest.proof.config.ts'))).toBe(true);
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:proof']).toContain('vitest.proof.config.ts');
  });
});
