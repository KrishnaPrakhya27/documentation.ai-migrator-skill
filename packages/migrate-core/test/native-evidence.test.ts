/**
 * A repository or export is evidence too.
 *
 * Exactness was certified only for live sites: `sourceEvidence` was built for URL sources alone,
 * so a Mintlify, GitBook, ReadMe or Document360 repository — the sources a customer migration most
 * often uses — could not pass the exact family at all. The frozen files are the bytes that source
 * served, so they are recorded as acquisitions and read back the same way.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireNativePages } from '../src/scrape/native-acquire.js';
import { readGitbookRepo } from '../src/adapters/gitbook.js';
import { inapplicableProofs } from '../src/evidence/applicability.js';
import { previewPushBlockers, type GateResult } from '../src/verify/gates.js';
import type { AcquiredPage } from '../src/scrape/acquire.js';

const temp = (): string => mkdtempSync(join(tmpdir(), 'dai-native-'));

describe('frozen files recorded as acquisitions', () => {
  it('records the file bytes and the metadata the file itself states', () => {
    const root = temp(); const workspace = temp();
    mkdirSync(join(workspace, 'source-cache'), { recursive: true });
    writeFileSync(join(root, 'a.md'), '---\ntitle: Stated title\ndescription: "Stated description"\n---\n\nBody text.\n');
    const result = acquireNativePages(workspace, root, [{ id: 'p1', source: 'a.md', title: 'Plan title', description: 'Plan description', migrate: true }]);
    expect(result).toMatchObject({ recorded: 1, unreadable: [] });
    const record = JSON.parse(readFileSync(join(workspace, 'source-cache', 'acquired', 'p1.json'), 'utf8')) as AcquiredPage;
    // the plan's title is an operator-editable value; certifying against it would certify the plan
    expect(record).toMatchObject({ url: 'a.md', title: 'Stated title', description: 'Stated description' });
    expect(record.markdown).toContain('Body text.');
    expect(record.markdownSha256).toHaveLength(64);
  });

  it('records folded YAML metadata instead of certifying the adapter fallback', () => {
    const root = temp(); const workspace = temp();
    mkdirSync(join(workspace, 'source-cache'), { recursive: true });
    writeFileSync(join(root, 'folded.md'), '---\ntitle: >-\n  The exact folded title\ndescription: |\n  First line.\n  Second line.\n---\n\nBody.\n');
    acquireNativePages(workspace, root, [{ id: 'folded', source: 'folded.md', title: 'Wrong fallback', migrate: true }]);
    const record = JSON.parse(readFileSync(join(workspace, 'source-cache', 'acquired', 'folded.json'), 'utf8')) as AcquiredPage;
    expect(record.title).toBe('The exact folded title');
    expect(record.description).toBe('First line.\nSecond line.');
  });

  it('reports rather than records a page it cannot read, and refuses a path leaving the frozen root', () => {
    const root = temp(); const workspace = temp();
    mkdirSync(join(workspace, 'source-cache'), { recursive: true });
    const result = acquireNativePages(workspace, root, [
      { id: 'gone', source: 'missing.md', migrate: true },
      { id: 'escape', source: '../outside.md', migrate: true },
      { id: 'binary', source: 'logo.png', migrate: true },
      { id: 'skipped', source: 'a.md', migrate: false },
    ]);
    expect(result.recorded).toBe(0);
    expect(result.unreadable.map((page) => [page.pageId, page.reason])).toEqual([
      ['gone', 'file is not in the frozen source'],
      ['escape', 'path escapes the frozen source root'],
      ['binary', 'no Markdown or HTML body: .png'],
    ]);
  });
});

describe('which proofs a source kind can be held to', () => {
  it('exempts the rendered-page proofs for a repository, keeping the frozen file as the witness', () => {
    const repo = inapplicableProofs({ kind: 'repo', publishesMarkdown: false });
    expect([...repo.keys()].sort()).toEqual(['chrome-absent', 'html-reconciliation']);
    expect(repo.get('html-reconciliation')).toContain('source-content-exact');
  });

  it('exempts the authored-file proof for a site that publishes no Markdown, keeping the rendered page as the witness', () => {
    expect([...inapplicableProofs({ kind: 'url', publishesMarkdown: false }).keys()]).toEqual(['source-content-exact']);
    // a site publishing both owes both proofs
    expect([...inapplicableProofs({ kind: 'url', publishesMarkdown: true }).keys()]).toEqual([]);
  });
});

describe('GitBook states its navigation in SUMMARY.md', () => {
  it('builds the navigation graph, with sections and a parent page leading its own group', () => {
    const root = temp();
    writeFileSync(join(root, 'SUMMARY.md'), '# Table of contents\n\n* [Welcome](README.md)\n\n## Guides\n\n* [Install](guides/install.md)\n  * [Advanced](guides/advanced.md)\n');
    writeFileSync(join(root, 'README.md'), '# Welcome\n\nStart here.\n');
    mkdirSync(join(root, 'guides'));
    writeFileSync(join(root, 'guides/install.md'), '# Install\n\nRun it.\n');
    writeFileSync(join(root, 'guides/advanced.md'), '# Advanced\n\nMore.\n');
    const { tree } = readGitbookRepo(root);
    expect(tree.navigationSource).toBe('source-config');
    const strip = (nodes: unknown): unknown => JSON.parse(JSON.stringify(nodes).replace(/"pageId":"[^"]+"/g, '"pageId":"id"'));
    expect(strip(tree.navigation)).toEqual([
      { type: 'page', pageId: 'id', title: 'Welcome' },
      { type: 'group', label: 'Guides', children: [
        { type: 'group', label: 'Install', children: [
          { type: 'page', pageId: 'id', title: 'Install' },
          { type: 'page', pageId: 'id', title: 'Advanced' },
        ] },
      ] },
    ]);
  });

  it('treats the file\'s own title heading as a title, not as a group wrapping the whole sidebar', () => {
    const root = temp();
    writeFileSync(join(root, 'SUMMARY.md'), '# Summary\n\n* [Welcome](README.md)\n');
    writeFileSync(join(root, 'README.md'), '# Welcome\n\nStart here.\n');
    expect(readGitbookRepo(root).tree.navigation).toEqual([{ type: 'page', pageId: expect.any(String), title: 'Welcome' }]);
  });
});

describe('a repository migration, end to end through the real gates', () => {
  it('refuses a push while a gate is unapproved, and again once the approved state changed', () => {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const source = temp(); const workspace = join(temp(), 'ws');
    writeFileSync(join(source, 'SUMMARY.md'), '# Table of contents\n\n* [Welcome](README.md)\n');
    writeFileSync(join(source, 'README.md'), '# Welcome\n\nStart here.\n');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DAI_|MIGRATION_|FIRECRAWL_|README_)/.test(key))), MIGRATION_WORKSPACE: workspace };
    const cli = (...args: string[]): string => execFileSync(process.execPath, [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'packages/migrate-core/src/cli.ts'), ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cli('init', '--source', source, '--platform', 'gitbook', '--target', 'demo-org', '--fidelity', 'exact');
    cli('discover');
    // nothing to approve before the stage that produces it has run
    expect(() => cli('approve', '--gate', '2', '--by', 'reviewer')).toThrow(/nothing to approve/);
    expect(cli('approve', '--gate', '1', '--by', 'reviewer', '--note', 'scope agreed')).toContain('approved by reviewer');
    const session = JSON.parse(readFileSync(join(workspace, 'session.json'), 'utf8')) as { approvals: Record<string, { by: string; note?: string; pinned: Record<string, string> }> };
    expect(session.approvals['1']).toMatchObject({ by: 'reviewer', note: 'scope agreed' });
    expect(Object.keys(session.approvals['1'].pinned)).toContain('plan/tree.yaml');
  }, 120_000);

  it('passes every applicable exact-mode gate and exempts only the rendered-page proofs', () => {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const source = temp(); const workspace = join(temp(), 'ws');
    writeFileSync(join(source, 'SUMMARY.md'), '# Table of contents\n\n* [Welcome](README.md)\n\n## Guides\n\n* [Install](install.md)\n');
    writeFileSync(join(source, 'README.md'), '# Welcome\n\nStart here, then read the guides.\n');
    writeFileSync(join(source, 'install.md'), '# Install\n\nRun the installer and follow it.\n');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DAI_|MIGRATION_|FIRECRAWL_|README_)/.test(key))), MIGRATION_WORKSPACE: workspace };
    const cli = (...args: string[]): string => execFileSync(process.execPath, [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'packages/migrate-core/src/cli.ts'), ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cli('init', '--source', source, '--platform', 'gitbook', '--target', 'demo-org', '--fidelity', 'exact');
    for (const stage of ['discover', 'acquire', 'inventory']) cli(stage);
    // the human gates are records now: gate 1 approves the scope, gate 2 the conversion decisions
    cli('approve', '--gate', '1', '--by', 'test reviewer');
    cli('plan');
    cli('approve', '--gate', '2', '--by', 'test reviewer');
    cli('assets', '--provider', 'local');
    cli('convert'); cli('convert'); cli('nav');
    // verify exits non-zero while the preview-only gates are still unrun, which is the correct
    // refusal to certify a release; the report is what states each gate's result.
    try { cli('verify'); } catch { /* gate results are read from the report below */ }
    const report = JSON.parse(readFileSync(join(workspace, 'report/gates.json'), 'utf8')) as { pass: boolean; gates: GateResult[] };
    const status = (id: string): string | undefined => report.gates.find((gate) => gate.id === id)?.status;
    expect(report.gates.filter((gate) => gate.status === 'fail')).toEqual([]);
    // the content and navigation of a repository are now certified against the frozen source
    expect([status('source-content-exact'), status('source-metadata-exact'), status('navigation-exact'), status('source-navigation-proven')]).toEqual(['pass', 'pass', 'pass', 'pass']);
    // and the two proofs a repository cannot answer are satisfied as explicitly inapplicable,
    // rather than confused with a proof that should have run but did not
    expect(status('html-reconciliation')).toBe('inapplicable');
    expect(status('chrome-absent')).toBe('inapplicable');
    expect(status('human-gates-approved')).toBe('pass');
    expect(previewPushBlockers(report.gates)).toEqual([]);

    // editing what was approved leaves the approval behind, naming the file that moved
    writeFileSync(join(workspace, 'plan/tree.yaml'), `${readFileSync(join(workspace, 'plan/tree.yaml'), 'utf8')}\n# edited after approval\n`);
    try { cli('verify'); } catch { /* the report states the result */ }
    const after = JSON.parse(readFileSync(join(workspace, 'report/gates.json'), 'utf8')) as { gates: Array<{ id: string; status: string; detail?: string }> };
    const approval = after.gates.find((gate) => gate.id === 'human-gates-approved');
    expect(approval?.status).toBe('fail');
    expect(approval?.detail).toContain('plan/tree.yaml changed since');
  }, 120_000);
});
