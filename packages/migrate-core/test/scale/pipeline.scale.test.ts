/**
 * What a large migration costs.
 *
 * The pipeline was only ever exercised on small corpora, so its behaviour at the size a customer
 * actually has was a guess. This runs the real commands over a generated corpus and holds them to
 * the budgets the quality contract states: a 500-page migration inside two minutes, and a run that
 * fits in the memory a normal machine has rather than whatever the machine happens to offer.
 *
 * Memory is asserted by capping the heap and requiring the run to finish, not by reading RSS: V8
 * grows its heap when memory is free, so RSS measures what was available, not what was needed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGES = Number(process.env.DAI_SCALE_PAGES ?? 500);
const repo = fileURLToPath(new URL('../../../../', import.meta.url));

/** A corpus with the shapes that cost real work: prose, a table, a code block and a list per page. */
function generateCorpus(pages: number): string {
  const root = mkdtempSync(join(tmpdir(), 'dai-scale-source-'));
  const words = 'install configure deploy monitor scale secure migrate index cache queue worker token policy region'.split(' ');
  let seed = 7;
  const next = (): string => { seed = (seed * 1103515245 + 12345) % 2147483648; return words[seed % words.length]; };
  for (let page = 0; page < pages; page++) {
    const section = `section-${Math.floor(page / 50)}`;
    mkdirSync(join(root, section), { recursive: true });
    const body = Array.from({ length: 6 }, () => Array.from({ length: 40 }, next).join(' ')).join('\n\n');
    const table = ['| Field | Meaning |', '| --- | --- |', ...Array.from({ length: 8 }, (_, row) => `| field_${row} | ${next()} value |`)].join('\n');
    writeFileSync(join(root, section, `page-${page}.md`),
      `---\ntitle: Page ${page}\ndescription: About page ${page}\n---\n\n# Page ${page}\n\n${body}\n\n${table}\n\n\`\`\`bash\nnpm install example\n\`\`\`\n\n- one\n- two\n`);
  }
  return root;
}

describe(`a ${PAGES}-page migration`, () => {
  const workspace = join(mkdtempSync(join(tmpdir(), 'dai-scale-ws-')), 'ws');
  let source = '';
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DAI_|MIGRATION_|FIRECRAWL_|README_)/.test(key))), MIGRATION_WORKSPACE: workspace };
  // Every stage runs under the same cap: the pipeline must fit in the memory it needs, on a machine
  // that has more. Node grows its heap when memory is free, so an uncapped run measures the machine.
  const heapMb = Number(process.env.DAI_SCALE_HEAP_MB ?? 512);
  const cli = (args: string[], extraEnv: Record<string, string> = {}): string => execFileSync(
    process.execPath,
    [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'packages/migrate-core/src/cli.ts'), ...args],
    { cwd: repo, env: { ...env, NODE_OPTIONS: `--max-old-space-size=${heapMb}`, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  beforeAll(() => { source = generateCorpus(PAGES); });

  it('runs discovery through navigation inside the stated budget', () => {
    const started = Date.now();
    cli(['init', '--source', source, '--platform', 'generic', '--target', 'demo-org', '--fidelity', 'exact']);
    for (const stage of ['discover', 'acquire', 'inventory']) cli([stage]);
    cli(['approve', '--gate', '1', '--by', 'scale test']);
    cli(['plan']);
    cli(['approve', '--gate', '2', '--by', 'scale test']);
    cli(['assets', '--provider', 'local']);
    cli(['convert']);
    cli(['convert']);
    cli(['nav']);
    const seconds = (Date.now() - started) / 1000;
    // the contract's budget is two minutes for 500 pages; larger corpora are given the same rate
    const budget = 120 * Math.max(1, PAGES / 500);
    expect(seconds, `the pipeline took ${seconds.toFixed(1)}s for ${PAGES} pages`).toBeLessThan(budget);
    const tree = readFileSync(join(workspace, 'plan', 'tree.yaml'), 'utf8');
    expect(tree.match(/^\s*- id:/gm)?.length, 'every generated page reaches the tree').toBe(PAGES);
  });

  it('verifies the whole corpus within a bounded heap', () => {
    let report: { gates: Array<{ id: string; status: string }> };
    try { cli(['verify']); }
    catch (error) {
      // A generic repository cannot prove its navigation, so verify exits non-zero by design; an
      // out-of-memory crash is a different failure and must not be read as that one.
      const output = String((error as { stdout?: string; stderr?: string }).stderr ?? '') + String((error as { stdout?: string }).stdout ?? '');
      expect(output, `verify ran out of memory with a ${heapMb}MB heap`).not.toMatch(/heap out of memory|Allocation failed/i);
    }
    report = JSON.parse(readFileSync(join(workspace, 'report', 'gates.json'), 'utf8')) as typeof report;
    const failed = report.gates.filter((gate) => gate.status === 'fail').map((gate) => gate.id);
    // the only failures a generated generic corpus should have are the navigation it cannot state
    expect(failed.sort()).toEqual(['navigation-exact', 'source-navigation-proven']);
  });
});
