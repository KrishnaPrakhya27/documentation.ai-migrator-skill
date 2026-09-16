/**
 * Block-level content ledger: every source IR node gets exactly one disposition.
 * Page accounting proves pages exist; the ledger proves paragraphs survived.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type Disposition =
  | { kind: 'identical'; pageId: string; sourceNodeId: string; outputNodeIds: string[] }
  | { kind: 'transformed'; pageId: string; sourceNodeId: string; outputNodeIds: string[]; rule: string; lossy: string[]; /** Links the rule wrote by the operator's decision (a card to a live tool on the source site). */ declaredLinks?: string[] }
  | { kind: 'excluded'; pageId: string; sourceNodeId: string; reason: string; reviewer?: string; at: string }
  | { kind: 'quarantined'; pageId: string; sourceNodeId: string; reason: string };

export type ExcludedDisposition = Extract<Disposition, { kind: 'excluded' }>;

export class Ledger {
  private path: string;
  private seen = new Map<string, Disposition>();
  constructor(workspace: string) {
    this.path = join(workspace, 'ledger', 'dispositions.jsonl');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
  }
  private write(d: Disposition) {
    const key = `${d.pageId}:${d.sourceNodeId}`;
    this.seen.set(key, d);
    appendFileSync(this.path, JSON.stringify(d) + '\n', { mode: 0o600 });
  }
  identical(pageId: string, sourceNodeId: string, outputNodeIds = [sourceNodeId]) { this.write({ kind: 'identical', pageId, sourceNodeId, outputNodeIds }); }
  transformed(pageId: string, sourceNodeId: string, outputNodeIds: string[], rule: string, lossy: string[] = [], declaredLinks: string[] = []) { this.write({ kind: 'transformed', pageId, sourceNodeId, outputNodeIds, rule, lossy, ...(declaredLinks.length ? { declaredLinks } : {}) }); }
  excluded(pageId: string, sourceNodeId: string, reason: string, reviewer?: string) { this.write({ kind: 'excluded', pageId, sourceNodeId, reason, reviewer, at: new Date().toISOString() }); }
  quarantined(pageId: string, sourceNodeId: string, reason: string) { this.write({ kind: 'quarantined', pageId, sourceNodeId, reason }); }

  static read(workspace: string): Disposition[] {
    const p = join(workspace, 'ledger', 'dispositions.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Disposition);
  }
}

export interface LedgerSummary {
  totalSource: number;
  covered: number;
  identical: number;
  transformed: number;
  lossy: number;
  excluded: number;
  excludedUnattributed: number;
  quarantined: number;
  missing: Array<{ pageId: string; sourceNodeId: string }>;
}

/** The disposition that stands for each node: convert may write several for one node, and the last one wins. */
function lastDispositions(dispositions: Disposition[]): Map<string, Disposition> {
  const last = new Map<string, Disposition>();
  for (const d of dispositions) last.set(`${d.pageId}:${d.sourceNodeId}`, d);
  return last;
}

/** Coverage against the set of source node ids captured at snapshot time. */
export function summarize(dispositions: Disposition[], sourceIds: Array<{ pageId: string; nodeId: string }>): LedgerSummary {
  const last = lastDispositions(dispositions);
  const s: LedgerSummary = { totalSource: sourceIds.length, covered: 0, identical: 0, transformed: 0, lossy: 0, excluded: 0, excludedUnattributed: 0, quarantined: 0, missing: [] };
  for (const { pageId, nodeId } of sourceIds) {
    const d = last.get(`${pageId}:${nodeId}`);
    if (!d) { s.missing.push({ pageId, sourceNodeId: nodeId }); continue; }
    s.covered++;
    if (d.kind === 'identical') s.identical++;
    else if (d.kind === 'transformed') { s.transformed++; if (d.lossy.length) s.lossy++; }
    else if (d.kind === 'excluded') { s.excluded++; if (!d.reviewer) s.excludedUnattributed++; }
    else s.quarantined++;
  }
  return s;
}

/** The standing `excluded` disposition of every source node that has one, in source order. */
export function effectiveExclusions(dispositions: Disposition[], sourceIds: Array<{ pageId: string; nodeId: string }>): ExcludedDisposition[] {
  const last = lastDispositions(dispositions);
  const out: ExcludedDisposition[] = [];
  for (const { pageId, nodeId } of sourceIds) {
    const d = last.get(`${pageId}:${nodeId}`);
    if (d?.kind === 'excluded') out.push(d);
  }
  return out;
}
