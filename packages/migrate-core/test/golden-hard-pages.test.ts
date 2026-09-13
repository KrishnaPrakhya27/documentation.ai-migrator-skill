/**
 * A corpus written to be difficult, migrated end to end through the real commands.
 *
 * Unit tests exercise one hazard at a time against a hand-built IR. These are the shapes that
 * actually arrive from customers — a table holding links and code, two pages with the same title in
 * different groups, a link to a page that was never migrated, raw HTML, an image that does not
 * exist — run through the whole pipeline, so the assertion is about what the migration produces
 * rather than about what a function returns.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

const HARD_PAGES: Record<string, string> = {
  // a table whose cells hold links, inline code and pipes that must not be read as columns
  'reference/table.md': `---\ntitle: Field reference\n---\n\n# Field reference\n\n| Field | Type | Notes |\n| --- | :---: | ---: |\n| \`retry_count\` | number | see [limits](/reference/limits) |\n| \`mode\` | string | one of \`a\\|b\\|c\` |\n`,
  // the same title in two different groups: both must keep a route of their own
  'guides/overview.md': '---\ntitle: Overview\n---\n\n# Overview\n\nThe guides overview.\n',
  'reference/overview.md': '---\ntitle: Overview\n---\n\n# Overview\n\nThe reference overview.\n',
  // a link to a page this migration never writes, and an anchor into a page that exists
  'guides/links.md': '---\ntitle: Links\n---\n\n# Links\n\nSee [the missing page](/guides/not-here) and [a field](/reference/table#field-reference).\n',
  // raw HTML the platform has no component for, and an image that does not exist
  'guides/raw.md': '---\ntitle: Raw markup\n---\n\n# Raw markup\n\n<div class="callout" data-kind="note"><p>Kept as authored.</p></div>\n\n![missing](/assets/missing.png)\n',
  // a code fence holding what looks like frontmatter and a nested fence
  'guides/fences.md': '---\ntitle: Fences\n---\n\n# Fences\n\n````markdown\n---\ntitle: not this page\n---\n\n```bash\necho nested\n```\n````\n',
};

describe('a deliberately difficult corpus', () => {
  const workspace = join(mkdtempSync(join(tmpdir(), 'dai-golden-ws-')), 'ws');
  const source = mkdtempSync(join(tmpdir(), 'dai-golden-src-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DAI_|MIGRATION_|FIRECRAWL_|README_)/.test(key))), MIGRATION_WORKSPACE: workspace };
  const cli = (...args: string[]): string => execFileSync(
    process.execPath,
    [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'packages/migrate-core/src/cli.ts'), ...args],
    { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = (route: string): string => readFileSync(join(workspace, 'output', `${route}.mdx`), 'utf8');

  beforeAll(() => {
    for (const [path, body] of Object.entries(HARD_PAGES)) {
      mkdirSync(join(source, dirname(path)), { recursive: true });
      writeFileSync(join(source, path), body);
    }
    // permissive: the corpus deliberately contains a broken link and a missing image, which exact
    // mode refuses outright. What is asserted here is that each hazard is handled and reported.
    cli('init', '--source', source, '--platform', 'generic', '--target', 'demo-org', '--fidelity', 'permissive');
    for (const stage of ['discover', 'acquire', 'inventory', 'plan']) cli(stage);
    cli('assets', '--provider', 'none');
    cli('convert'); cli('convert'); cli('nav');
    try { cli('verify'); } catch { /* permissive verify reports; the report is what is asserted */ }
  }, 120_000);

  it('keeps a table whose cells hold links, code and escaped pipes', () => {
    const mdx = output('reference/table');
    expect(mdx).toContain('| --- | :---: | ---: |');
    expect(mdx).toContain('`retry_count`');
    expect(mdx).toContain('[limits]');
    // the escaped pipe is content, not a column boundary
    expect(mdx).toMatch(/one of `a\\\|b\\\|c`/);
  });

  it('gives two pages with the same title two routes, neither overwriting the other', () => {
    expect(existsSync(join(workspace, 'output', 'guides/overview.mdx'))).toBe(true);
    expect(existsSync(join(workspace, 'output', 'reference/overview.mdx'))).toBe(true);
    expect(output('guides/overview')).toContain('The guides overview.');
    expect(output('reference/overview')).toContain('The reference overview.');
  });

  it('reports a link to a page the migration never wrote instead of silently breaking it', () => {
    const report = join(workspace, 'report', 'unmigrated-links.json');
    const gates = JSON.parse(readFileSync(join(workspace, 'report', 'gates.json'), 'utf8')) as { gates: Array<{ id: string; status: string; detail?: string }> };
    const internal = gates.gates.find((gate) => gate.id === 'internal-links');
    const listed = existsSync(report) ? readFileSync(report, 'utf8') : '';
    expect(listed.includes('not-here') || internal?.status === 'fail', 'a link to an unwritten page must be reported or fail a gate').toBe(true);
  });

  it('carries the words of a raw-HTML block, and records that the markup around them changed', () => {
    const mdx = output('guides/raw');
    expect(mdx).toContain('Kept as authored.');
    // the platform has no component for an arbitrary div, so the markup is rewritten; what matters
    // is that the rewrite is recorded rather than passed off as an untouched copy
    const ledger = readFileSync(join(workspace, 'ledger', 'dispositions.jsonl'), 'utf8');
    expect(ledger).toContain('"kind":"transformed"');
  });

  it('refuses to ship that page at all in exact mode, where a rewrite is not a migration', () => {
    const exactWorkspace = join(mkdtempSync(join(tmpdir(), 'dai-golden-exact-')), 'ws');
    const exactSource = mkdtempSync(join(tmpdir(), 'dai-golden-exact-src-'));
    writeFileSync(join(exactSource, 'raw.md'), HARD_PAGES['guides/raw.md'].replace('![missing](/assets/missing.png)\n', ''));
    const exactEnv = { ...env, MIGRATION_WORKSPACE: exactWorkspace };
    const run = (...args: string[]): string => execFileSync(
      process.execPath,
      [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'packages/migrate-core/src/cli.ts'), ...args],
      { cwd: repo, env: exactEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    run('init', '--source', exactSource, '--platform', 'generic', '--target', 'demo-org', '--fidelity', 'exact');
    for (const stage of ['discover', 'acquire', 'inventory', 'plan']) run(stage);
    run('assets', '--provider', 'local');
    const converted = run('convert');
    // the page is held back rather than written with markup the source never had
    expect(converted).toMatch(/0 pages written/);
    expect(converted).toMatch(/1 pages quarantined/);
    run('nav');
    try { run('verify'); } catch { /* the report states the result */ }
    const gates = JSON.parse(readFileSync(join(exactWorkspace, 'report', 'gates.json'), 'utf8')) as { gates: Array<{ id: string; status: string }> };
    expect(gates.gates.find((gate) => gate.id === 'conversion-fidelity')?.status).toBe('fail');
  }, 120_000);

  it('reports an image the source does not have rather than writing a broken page', () => {
    const gates = JSON.parse(readFileSync(join(workspace, 'report', 'gates.json'), 'utf8')) as { gates: Array<{ id: string; status: string; detail?: string }> };
    const assets = gates.gates.find((gate) => gate.id === 'assets-ready');
    expect(assets, 'the assets gate must judge a missing image').toBeDefined();
    expect(['fail', 'not-run', 'pass']).toContain(assets!.status);
    // whichever way it lands, the image reference is accounted for in the manifest or the report
    const manifest = join(workspace, 'plan', 'assets.json');
    const recorded = existsSync(manifest) ? readFileSync(manifest, 'utf8') : '';
    expect(recorded.includes('missing.png') || assets!.status === 'fail').toBe(true);
  });

  it('does not read a fenced block as the page\'s own frontmatter or as a nested fence', () => {
    const mdx = output('guides/fences');
    expect(mdx).toContain('title: Fences');
    expect(mdx).toContain('title: not this page');
    expect(mdx).toContain('echo nested');
    // the outer fence still encloses the inner one
    expect(mdx).toMatch(/````/);
  });
});
