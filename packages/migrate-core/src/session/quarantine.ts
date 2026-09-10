/**
 * quarantine/<pageId>.json: pages that convert refused to write, by cause.
 * A page held for unresolved snippet tokens is a source-completeness problem;
 * a page quarantined for an exact-fidelity violation is a conversion problem.
 * Stage notes and reports keep the two apart.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FidelityValue } from '../verify/fidelity.js';

export type QuarantineKind = 'blocked-snippet' | 'exact-fidelity';

export interface QuarantineRecord {
  kind: QuarantineKind;
  reason: string;
  /** Output path the page would have been written to. */
  page: string;
  sourceSnapshot?: FidelityValue;
  resolvedSnapshot?: FidelityValue;
}

export interface QuarantineCounts {
  total: number;
  blockedSnippet: number;
  exactFidelity: number;
}

const QUARANTINE_KINDS: ReadonlySet<string> = new Set<QuarantineKind>(['blocked-snippet', 'exact-fidelity']);

function quarantineDir(workspace: string): string {
  return join(workspace, 'quarantine');
}

export function writeQuarantine(workspace: string, pageId: string, record: QuarantineRecord): void {
  const dir = quarantineDir(workspace);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${pageId}.json`), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

export function readQuarantine(workspace: string): Array<{ pageId: string; record: QuarantineRecord }> {
  const dir = quarantineDir(workspace);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.json')).sort().map((file) => {
    const record = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Partial<QuarantineRecord>;
    if (typeof record.kind !== 'string' || !QUARANTINE_KINDS.has(record.kind)) throw new Error(`quarantine/${file} records no quarantine kind; it was written by an older migrator build. Re-run convert.`);
    return { pageId: file.replace(/\.json$/, ''), record: record as QuarantineRecord };
  });
}

export function countQuarantine(workspace: string): QuarantineCounts {
  const records = readQuarantine(workspace);
  return {
    total: records.length,
    blockedSnippet: records.filter(({ record }) => record.kind === 'blocked-snippet').length,
    exactFidelity: records.filter(({ record }) => record.kind === 'exact-fidelity').length,
  };
}
