import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWorkspace, writeSession, type Session } from '../src/session/workspace.js';
import { pinGateSubjects } from '../src/session/approvals.js';
import { canonicalHash, REQUIRED_RELEASE_GATE_IDS, type GateResult } from '../src/verify/gates.js';

describe('release certification', () => {
  it('requires all four immutable approvals and certifies the exact previewed output', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const workspace = mkdtempSync(join(tmpdir(), 'dai-release-'));
    ensureWorkspace(workspace);
    writeFileSync(join(workspace, 'output', 'index.mdx'), '---\ntitle: Home\n---\n\nExact body.\n');
    const outputHash = canonicalHash(join(workspace, 'output'));
    const gates: GateResult[] = REQUIRED_RELEASE_GATE_IDS.map((id) => ({ id, status: id === 'html-reconciliation' || id === 'chrome-absent' ? 'inapplicable' : 'pass', detail: 'complete' }));
    const report = JSON.stringify({ at: '2026-09-13T00:00:00.000Z', outputHash, pass: true, gates }, null, 2);
    writeFileSync(join(workspace, 'report', 'pre-push-gates.json'), report);
    writeFileSync(join(workspace, 'report', 'preview-gates.json'), report);
    writeFileSync(join(workspace, 'report', 'preview-routes.json'), '[]');
    writeFileSync(join(workspace, 'report', 'responsive.json'), '[]');
    const prior = { at: '2026-09-13T00:00:00.000Z', by: 'reviewer', pinned: {} };
    const session: Session = {
      migrationId: 'migration-test', createdAt: '2026-09-13T00:00:00.000Z',
      source: { kind: 'repo', location: '/source', platform: 'generic' },
      target: { landing: 'demo-org', previewUrl: 'https://preview.example/' }, scope: 'full', customerAuthorisedCrawl: false, fidelityMode: 'exact',
      migrator: { gitSha: '0'.repeat(40), dirty: false, dirtyHash: null, packageVersion: '0.1.0' },
      versions: { core: '0.1.0', contentContract: '0.1.0', parsers: {} }, hashes: { canonicalOutput: outputHash },
      stages: { write: { status: 'done', note: 'migration/test@12345678' }, verify: { status: 'done' } },
      approvals: { 1: prior, 2: prior },
    };
    session.approvals![3] = { ...prior, pinned: pinGateSubjects(workspace, 3) };
    session.approvals![4] = { ...prior, pinned: pinGateSubjects(workspace, 4) };
    writeSession(workspace, session);
    const stdout = execFileSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'packages/migrate-core/src/cli.ts'), 'release', '--workspace', workspace], { cwd: root, encoding: 'utf8' });
    expect(stdout).toContain('release certificate written');
    const certificate = JSON.parse(readFileSync(join(workspace, 'report', 'release-certificate.json'), 'utf8')) as { outputHash: string; previewReportHash: string; approvals: Record<string, unknown> };
    expect(certificate.outputHash).toBe(outputHash);
    expect(certificate.previewReportHash).toHaveLength(64);
    expect(Object.keys(certificate.approvals)).toEqual(['1', '2', '3', '4']);
  });
});
