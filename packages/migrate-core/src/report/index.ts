/**
 * Reports from one dataset: gates.json, review-queue.md, summary.md, and
 * platform-gaps.json. A future customer-report renderer can consume the same files.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gateSatisfied, releaseBlockers, type GateResult } from '../verify/gates.js';
import type { ClusterEntry } from '../components/signature.js';
import type { Decision } from '../log/decisions.js';
import type { Session } from '../session/workspace.js';
import { describeMigrator, type MigratorProvenance } from '../session/provenance.js';
import type { QuarantineCounts } from '../session/quarantine.js';
import type { Tree } from '../nav/tree.js';

export interface GateReport { at: string; outputHash?: string; pass: boolean; gates: GateResult[] }

export function gateReport(gates: GateResult[], outputHash?: string): GateReport {
  return { at: new Date().toISOString(), outputHash, pass: releaseBlockers(gates).length === 0, gates };
}

export function writeGates(workspace: string, gates: GateResult[], outputHash?: string, files: string | string[] = 'gates.json'): GateReport {
  const report = gateReport(gates, outputHash);
  const body = JSON.stringify(report, null, 2);
  for (const file of typeof files === 'string' ? [files] : files) writeFileSync(join(workspace, 'report', file), body, { mode: 0o600 });
  return report;
}

export function readDecisions(workspace: string): Decision[] {
  const p = join(workspace, 'logging', 'decisions.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Decision) : [];
}

export function writeReviewQueue(workspace: string, gates: GateResult[], clusters: ClusterEntry[], planStatus: Record<string, string>): void {
  const lines: string[] = ['# Review queue', ''];
  const failed = gates.filter((g) => !gateSatisfied(g));
  lines.push(`## Gates: ${failed.length ? `${failed.length} failing or not run` : 'all passing'}`, '');
  for (const g of gates) {
    lines.push(`- **${g.id}** — ${g.status.toUpperCase()}: ${g.detail}${g.samples?.length ? `\n  - ${g.samples.join('\n  - ')}` : ''}`);
    // how the platform draws a page: listed so it can be looked at, never counted as a failure
    if (g.advisories) lines.push(`  - _${g.advisories} note(s), not failures:_${g.advisorySamples?.length ? `\n    - ${g.advisorySamples.join('\n    - ')}` : ''}`);
  }
  lines.push('', '## Component clusters needing review', '');
  const needs = clusters.filter((c) => (planStatus[c.signature.hash] ?? 'needs-review') === 'needs-review');
  if (!needs.length) lines.push('_none_');
  for (const c of needs) lines.push(`- \`${c.cluster}\` × ${c.count} — props ${JSON.stringify(c.signature.props)}; samples: ${c.samples.map((s) => `${s.pageId}:${s.nodeId}`).join(', ')}`);
  // links to pages this migration does not write: convert lists each one; the unmigrated-links gate counts what the output still points at
  const unmigratedFile = join(workspace, 'report', 'unmigrated-links.json');
  const unmigrated = existsSync(unmigratedFile) ? JSON.parse(readFileSync(unmigratedFile, 'utf8')) as Array<{ route: string; url: string; target: string; knownSourcePage: boolean }> : [];
  lines.push('', `## Links to pages this migration does not write (${unmigrated.length})`, '');
  if (!unmigrated.length) lines.push('_none_');
  for (const link of unmigrated) lines.push(`- \`${link.route}\` → ${link.url}${link.target !== link.url ? ` (now ${link.target})` : ''}${link.knownSourcePage ? '' : ' — not a page the source is known to publish'}`);
  writeFileSync(join(workspace, 'report', 'review-queue.md'), lines.join('\n') + '\n', { mode: 0o600 });
}

export function writePlatformGaps(workspace: string, decisions: Decision[], shims: number): void {
  const gaps = decisions.filter((d) => d.tier === 'T4' || d.tier === 'T6' || d.tier === 'T7');
  const byRule = new Map<string, number>();
  for (const g of gaps) byRule.set(`${g.tier}:${g.rule ?? g.note ?? 'unknown'}`, (byRule.get(`${g.tier}:${g.rule ?? g.note ?? 'unknown'}`) ?? 0) + 1);
  writeFileSync(join(workspace, 'report', 'platform-gaps.json'), JSON.stringify({ anchorShims: shims, decisions: [...byRule.entries()].map(([k, count]) => ({ key: k, count })) }, null, 2), { mode: 0o600 });
}

/** What every report says about the run itself, so nobody has to remember which build and mode produced the output. */
export interface RunProvenance {
  fidelityMode: 'exact' | 'permissive';
  navigationSource?: Tree['navigationSource'];
  migrator: MigratorProvenance;
  quarantine: QuarantineCounts;
}

function provenanceLines(p: RunProvenance): string[] {
  return [
    `- fidelity: ${p.fidelityMode}`,
    `- navigation source: ${p.navigationSource ?? 'not recorded'}`,
    `- migrator: ${describeMigrator(p.migrator)}`,
    `- pages quarantined (exact-fidelity): ${p.quarantine.exactFidelity}`,
    `- pages held (blocked snippet tokens): ${p.quarantine.blockedSnippet}`,
    `- pages not written for any reason: ${p.quarantine.total}`,
  ];
}

export function writeSummary(workspace: string, s: { pages: number; converted: number; clusters: number; assets: number; gates: GateResult[]; branch?: string; provenance: RunProvenance }): void {
  const failed = s.gates.filter((g) => g.status === 'fail').length;
  const notRun = s.gates.filter((g) => g.status === 'not-run').length;
  const inapplicable = s.gates.filter((g) => g.status === 'inapplicable').length;
  const blockers = releaseBlockers(s.gates).length;
  const md = `# Migration summary

| | |
|---|---|
| Pages in scope | ${s.pages} |
| Converted | ${s.converted} |
| Held (blocked snippet tokens) | ${s.provenance.quarantine.blockedSnippet} |
| Quarantined (exact-fidelity) | ${s.provenance.quarantine.exactFidelity} |
| Not written, all reasons | ${s.provenance.quarantine.total} |
| Component clusters | ${s.clusters} |
| Assets | ${s.assets} |
| Gates failing | ${failed} |
| Gates not run | ${notRun} |
| Gates inapplicable (satisfied) | ${inapplicable} |
| Required release blockers | ${blockers} |
| Branch | ${s.branch ?? '-'} |

Release is ${blockers === 0 ? 'ALLOWED' : 'BLOCKED'} by the complete required gate set. See review-queue.md.

## Provenance

${provenanceLines(s.provenance).join('\n')}
`;
  writeFileSync(join(workspace, 'report', 'summary.md'), md, { mode: 0o600 });
}

/** What was verified about the target at init and discovered at write, plus which build ran, so the report never relies on memory. */
export function writeConnectionSummary(workspace: string, s: Session, provenance: RunProvenance): void {
  const preflightPath = join(workspace, 'report', 'preflight.json');
  const preflight = existsSync(preflightPath) ? JSON.parse(readFileSync(preflightPath, 'utf8')) as Array<{ id: string; status: string; detail: string }> : [];
  const t = s.target;
  const lines = [
    '# Target connection',
    '',
    `| | |`, `|---|---|`,
    `| Landing | ${t.landing} |`,
    `| Remote | ${t.repoRemote ?? 'not set'} |`,
    `| Live deployment branch | ${t.deploymentBranch ?? 'unknown'} |`,
    `| Connected repository verified | ${t.connectedRepoVerified === undefined ? 'not checked' : t.connectedRepoVerified ? 'yes' : 'no'} |`,
    `| Push access verified | ${t.pushAccessVerified === undefined ? 'not checked' : t.pushAccessVerified ? 'yes' : 'no'} |`,
    `| Asset provider | ${t.assetProvider ?? 'local'} |`,
    `| Media API (G7) | ${t.mediaApiAvailable ? 'available' : 'not available'} |`,
    `| Content contract | ${t.contractVersionAssumed ? `assumed ${s.versions.contentContract} (platform does not expose contentContractVersion)` : t.contentContractVersion ?? s.versions.contentContract} |`,
    `| Preview | ${t.previewUrl ?? 'not created'} |`,
    '',
    '## Provenance',
    '',
    ...provenanceLines(provenance),
    '',
    '## Preflight checks at init',
    '',
    ...preflight.map((c) => `- ${c.status === 'ok' ? '✔' : c.status === 'fail' ? '✖' : '·'} **${c.id}**: ${c.detail}`),
    '',
  ];
  writeFileSync(join(workspace, 'report', 'connection.md'), lines.join('\n'), { mode: 0o600 });
}
