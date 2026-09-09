/**
 * Reports from one dataset: gates.json, review-queue.md, summary.md, and
 * platform-gaps.json. A future customer-report renderer can consume the same files.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GateResult } from '../verify/gates.js';
import type { ClusterEntry } from '../components/signature.js';
import type { Decision } from '../log/decisions.js';

export function writeGates(workspace: string, gates: GateResult[]): void {
  writeFileSync(join(workspace, 'report', 'gates.json'), JSON.stringify({ at: new Date().toISOString(), pass: gates.every((g) => g.status === 'pass'), gates }, null, 2), { mode: 0o600 });
}

export function readDecisions(workspace: string): Decision[] {
  const p = join(workspace, 'logging', 'decisions.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Decision) : [];
}

export function writeReviewQueue(workspace: string, gates: GateResult[], clusters: ClusterEntry[], planStatus: Record<string, string>): void {
  const lines: string[] = ['# Review queue', ''];
  const failed = gates.filter((g) => g.status !== 'pass');
  lines.push(`## Gates: ${failed.length ? `${failed.length} failing or not run` : 'all passing'}`, '');
  for (const g of gates) lines.push(`- **${g.id}** — ${g.status.toUpperCase()}: ${g.detail}${g.samples?.length ? `\n  - ${g.samples.join('\n  - ')}` : ''}`);
  lines.push('', '## Component clusters needing review', '');
  const needs = clusters.filter((c) => (planStatus[c.signature.hash] ?? 'needs-review') === 'needs-review');
  if (!needs.length) lines.push('_none_');
  for (const c of needs) lines.push(`- \`${c.cluster}\` × ${c.count} — props ${JSON.stringify(c.signature.props)}; samples: ${c.samples.map((s) => `${s.pageId}:${s.nodeId}`).join(', ')}`);
  writeFileSync(join(workspace, 'report', 'review-queue.md'), lines.join('\n') + '\n', { mode: 0o600 });
}

export function writePlatformGaps(workspace: string, decisions: Decision[], shims: number): void {
  const gaps = decisions.filter((d) => d.tier === 'T4' || d.tier === 'T6' || d.tier === 'T7');
  const byRule = new Map<string, number>();
  for (const g of gaps) byRule.set(`${g.tier}:${g.rule ?? g.note ?? 'unknown'}`, (byRule.get(`${g.tier}:${g.rule ?? g.note ?? 'unknown'}`) ?? 0) + 1);
  writeFileSync(join(workspace, 'report', 'platform-gaps.json'), JSON.stringify({ anchorShims: shims, decisions: [...byRule.entries()].map(([k, count]) => ({ key: k, count })) }, null, 2), { mode: 0o600 });
}

export function writeSummary(workspace: string, s: { pages: number; converted: number; quarantined: number; clusters: number; assets: number; gates: GateResult[]; branch?: string }): void {
  const failed = s.gates.filter((g) => g.status === 'fail').length;
  const notRun = s.gates.filter((g) => g.status === 'not-run').length;
  const md = `# Migration summary

| | |
|---|---|
| Pages in scope | ${s.pages} |
| Converted | ${s.converted} |
| Quarantined pages | ${s.quarantined} |
| Component clusters | ${s.clusters} |
| Assets | ${s.assets} |
| Gates failing | ${failed} |
| Gates not run | ${notRun} |
| Branch | ${s.branch ?? '-'} |

Release is ${failed === 0 && notRun === 0 ? 'ALLOWED' : 'BLOCKED'} by the gates. See review-queue.md.
`;
  writeFileSync(join(workspace, 'report', 'summary.md'), md, { mode: 0o600 });
}
