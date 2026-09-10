import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureMigratorProvenance, migratorDrift, type GitRunner, type MigratorProvenance } from '../src/session/provenance.js';
import { countQuarantine, writeQuarantine } from '../src/session/quarantine.js';
import { ensureWorkspace, readSession, type Session } from '../src/session/workspace.js';
import { sha256 } from '../src/session/ids.js';
import { writeTree } from '../src/nav/tree.js';
import { previewPushBlockers, REQUIRED_RELEASE_GATE_IDS, runGates, type GateInput } from '../src/verify/gates.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cliEntry = join(repoRoot, 'packages', 'migrate-core', 'src', 'cli.ts');
const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const packageVersion = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;

/** No platform, remote or workspace configuration reaches the subprocess, so init settles offline. */
const offlineEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DAI_|MIGRATION_|FIRECRAWL_)/.test(key)));

function dai(args: string[]): string {
  return execFileSync(process.execPath, [tsx, cliEntry, ...args], { cwd: repoRoot, encoding: 'utf8', env: offlineEnv, stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const cleanup: string[] = [];
function temp(prefix: string): string {
  const p = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(p);
  return p;
}
afterAll(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

const HEAD = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const TRACKED_DIFF = 'diff --git a/packages/migrate-core/src/cli.ts b/packages/migrate-core/src/cli.ts\n--- a/packages/migrate-core/src/cli.ts\n+++ b/packages/migrate-core/src/cli.ts\n@@ -1 +1 @@\n-old\n+new\n';
interface FakeTree { head?: string; status?: string; diff?: string; blobs?: Record<string, string> }

/** Describes an imagined checkout through the git runner; no real repository is read. */
function fakeGit(tree: FakeTree): GitRunner {
  return (args) => {
    switch (args[0]) {
      case 'rev-parse': return `${tree.head ?? HEAD}\n`;
      case 'status': return tree.status ?? '';
      case 'diff': return tree.diff ?? '';
      case 'hash-object': {
        const blob = tree.blobs?.[args[2]];
        if (!blob) throw new Error(`unexpected hash-object for ${args[2]}`);
        return `${blob}\n`;
      }
      default: throw new Error(`unexpected git ${args.join(' ')}`);
    }
  };
}
const capture = (tree: FakeTree): MigratorProvenance => captureMigratorProvenance({ repoRoot: '/migrator', packageVersion: '0.1.0', git: fakeGit(tree) });
const dirtyTree: FakeTree = { status: ' M packages/migrate-core/src/cli.ts\0?? packages/migrate-core/src/new.ts\0', diff: TRACKED_DIFF, blobs: { 'packages/migrate-core/src/new.ts': BLOB } };

describe('migrator provenance', () => {
  let workspace: string;
  let session: Session;
  beforeAll(() => {
    workspace = temp('dai-session-');
    dai(['init', '--workspace', workspace, '--source', 'https://docs.example.test', '--target', 'demo-org']);
    session = readSession(workspace);
  }, 60_000);

  it('init pins the migrator commit, dirty state and package version in session.json', () => {
    expect(session.migrator.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(session.migrator.gitSha).toBe(git(['rev-parse', 'HEAD']));
    expect(session.migrator.packageVersion).toBe(packageVersion);
    expect(session.migrator.dirty).toBe(git(['status', '--porcelain', '--untracked-files=all']).length > 0);
    expect(session.migrator.dirtyHash).toEqual(session.migrator.dirty ? expect.stringMatching(/^[0-9a-f]{64}$/) : null);
    expect(session.fidelityMode).toBe('exact');
  });

  it('a dirty checkout yields a 64-hex hash that tracks both tracked and untracked changes; a clean one yields null', () => {
    const dirty = capture(dirtyTree);
    expect(dirty).toEqual({ gitSha: HEAD, dirty: true, dirtyHash: expect.stringMatching(/^[0-9a-f]{64}$/), packageVersion: '0.1.0' });
    expect(capture(dirtyTree).dirtyHash).toBe(dirty.dirtyHash);
    expect(capture({ ...dirtyTree, diff: TRACKED_DIFF.replace('+new', '+other') }).dirtyHash).not.toBe(dirty.dirtyHash);
    expect(capture({ ...dirtyTree, blobs: { 'packages/migrate-core/src/new.ts': 'c'.repeat(40) } }).dirtyHash).not.toBe(dirty.dirtyHash);
    expect(capture({})).toEqual({ gitSha: HEAD, dirty: false, dirtyHash: null, packageVersion: '0.1.0' });
  });

  it('hashes exactly the git diff against HEAD when only tracked files changed, and skips the original path of a rename', () => {
    const modified = capture({ status: ' M packages/migrate-core/src/cli.ts\0', diff: TRACKED_DIFF });
    expect(modified.dirtyHash).toBe(sha256(TRACKED_DIFF));
    const renameDiff = 'diff --git a/packages/a.ts b/packages/b.ts\nsimilarity index 100%\nrename from packages/a.ts\nrename to packages/b.ts\n';
    const renamed = capture({ status: 'R  packages/b.ts\0packages/a.ts\0', diff: renameDiff });
    expect(renamed).toEqual({ gitSha: HEAD, dirty: true, dirtyHash: sha256(renameDiff), packageVersion: '0.1.0' });
  });

  it('refuses to pin a migrator that is not a git checkout', () => {
    const noRepo: GitRunner = () => { throw Object.assign(new Error('git failed'), { stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }); };
    expect(() => captureMigratorProvenance({ repoRoot: '/elsewhere', packageVersion: '0.1.0', git: noRepo })).toThrow(/\/elsewhere is not a git checkout.*fatal: not a git repository/);
    expect(() => capture({ head: 'HEAD' })).toThrow(/unexpected "git rev-parse HEAD" output "HEAD"/);
  });

  it('migrator-pinned fails in runGates when the session SHA, diff hash or package version drifts', () => {
    const ws = temp('dai-gates-'); ensureWorkspace(ws);
    const current: MigratorProvenance = { gitSha: HEAD, dirty: false, dirtyHash: null, packageVersion: '0.1.0' };
    const base: GateInput = { workspace: ws, outputDir: join(ws, 'output'), sourceDocs: [], treePages: [], quarantinedPages: new Set(), excludedPages: new Set(), unreviewed: 0, pinnedContractVersion: '0.1.0', currentMigrator: current };
    const gate = (input: GateInput) => runGates(input).find((g) => g.id === 'migrator-pinned')!;
    expect(gate({ ...base, pinnedMigrator: current })).toMatchObject({ status: 'pass', detail: `migrator ${HEAD} (clean) v0.1.0`, count: 0 });
    const altered = 'f'.repeat(40);
    expect(gate({ ...base, pinnedMigrator: { ...current, gitSha: altered } })).toMatchObject({ status: 'fail', count: 1, samples: [`commit ${altered} → ${HEAD}`] });
    const dirtyHash = 'd'.repeat(64);
    expect(gate({ ...base, pinnedMigrator: { ...current, dirty: true, dirtyHash } })).toMatchObject({ status: 'fail', samples: [`uncommitted changes dirty, diff sha256 ${dirtyHash} → clean`] });
    expect(gate({ ...base, pinnedMigrator: { ...current, packageVersion: '0.2.0' } })).toMatchObject({ status: 'fail', samples: ['package version 0.2.0 → 0.1.0'] });
    expect(gate(base)).toMatchObject({ status: 'fail', detail: 'session.json records no migrator provenance; re-run init with this migrator' });
    expect(gate({ ...base, currentMigrator: undefined, pinnedMigrator: current }).status).toBe('not-run');
    expect(migratorDrift(current, current)).toEqual([]);
  });

  it('migrator-pinned is a required release gate that blocks the preview push', () => {
    expect(REQUIRED_RELEASE_GATE_IDS).toContain('migrator-pinned');
    const allPass = REQUIRED_RELEASE_GATE_IDS.map((id) => ({ id, status: 'pass' as const, detail: '' }));
    expect(previewPushBlockers(allPass.map((g) => g.id === 'migrator-pinned' ? { ...g, status: 'fail' as const } : g)).map((g) => g.id)).toEqual(['migrator-pinned']);
    expect(previewPushBlockers(allPass.map((g) => g.id === 'migrator-pinned' ? { ...g, status: 'not-run' as const } : g)).map((g) => g.id)).toEqual(['migrator-pinned']);
  });

  it('report/summary.md and connection.md print the fidelity mode, navigation source, migrator and quarantine causes', () => {
    writeTree(workspace, { scope: 'full', platform: 'generic', pages: [], navigationSource: 'manual' });
    writeQuarantine(workspace, 'page-a', { kind: 'exact-fidelity', reason: 'exact-fidelity violation at $.blocks[2]', page: 'guides/a' });
    writeQuarantine(workspace, 'page-b', { kind: 'blocked-snippet', reason: 'blocked snippet token(s) unresolved', page: 'guides/b' });
    dai(['report', '--workspace', workspace]);
    const summary = readFileSync(join(workspace, 'report', 'summary.md'), 'utf8');
    const connection = readFileSync(join(workspace, 'report', 'connection.md'), 'utf8');
    const expectedMigratorLine = `- migrator: ${session.migrator.gitSha} (${session.migrator.dirty ? `dirty, diff sha256 ${session.migrator.dirtyHash}` : 'clean'}) v${packageVersion}`;
    for (const report of [summary, connection]) {
      expect(report).toContain('- fidelity: exact');
      expect(report).toContain('- navigation source: manual');
      expect(report).toContain(expectedMigratorLine);
      expect(report).toContain('- pages quarantined (exact-fidelity): 1');
      expect(report).toContain('- pages held (blocked snippet tokens): 1');
    }
    expect(summary).toContain('| Held (blocked snippet tokens) | 1 |');
    expect(summary).toContain('| Quarantined (exact-fidelity) | 1 |');
  }, 60_000);

  it('quarantine counts separate the two causes and refuse records without a kind', () => {
    const ws = temp('dai-quarantine-'); ensureWorkspace(ws);
    expect(countQuarantine(ws)).toEqual({ total: 0, blockedSnippet: 0, exactFidelity: 0 });
    writeQuarantine(ws, 'p1', { kind: 'exact-fidelity', reason: 'r', page: 'a' });
    writeQuarantine(ws, 'p2', { kind: 'exact-fidelity', reason: 'r', page: 'b' });
    writeQuarantine(ws, 'p3', { kind: 'blocked-snippet', reason: 'r', page: 'c' });
    expect(countQuarantine(ws)).toEqual({ total: 3, blockedSnippet: 1, exactFidelity: 2 });
    writeFileSync(join(ws, 'quarantine', 'legacy.json'), JSON.stringify({ reason: 'r', page: 'd' }));
    expect(() => countQuarantine(ws)).toThrow(/quarantine\/legacy\.json records no quarantine kind/);
  });

  it('refuses a session that records no migrator provenance', () => {
    const ws = temp('dai-legacy-'); ensureWorkspace(ws);
    writeFileSync(join(ws, 'session.json'), JSON.stringify({ migrationId: 'mig-1', stages: {} }));
    expect(() => readSession(ws)).toThrow(/records no migrator provenance/);
  });
});
