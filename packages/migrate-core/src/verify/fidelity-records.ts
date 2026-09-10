/**
 * inventory/fidelity.json: one record per snapshot page, written by convert and
 * read by the conversion-fidelity and serialized-output-exact gates. A page that
 * convert never resolved (held for a blocked snippet token, or outside the
 * migration scope) still gets a record, so the gates can tell "convert never
 * accounted for this page" (a failure) from "convert deliberately skipped it"
 * (accounted for by pages-accounted and the quarantine).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DocIR } from '../ir/types.js';
import type { FidelityValue } from './fidelity.js';

export type UnconvertedReason = 'held' | 'not-migrated';

/** The page went through component conversion; `pass` says whether its authored content survived. */
export interface ConvertedFidelityRecord {
  pageId: string;
  source: string;
  pass: boolean;
  /** First differing snapshot path when `pass` is false. */
  difference?: string;
  sourceSnapshot: FidelityValue;
  resolvedSnapshot: FidelityValue;
  /** Exact target IR shape the written MDX must re-parse to. */
  expectedOutput: FidelityValue;
}

/** The page was not converted: held for a blocked snippet token, or not in the migration scope. */
export interface UnconvertedFidelityRecord {
  pageId: string;
  source: string;
  pass: null;
  reason: UnconvertedReason;
}

export type FidelityRecord = ConvertedFidelityRecord | UnconvertedFidelityRecord;

export function isConvertedFidelityRecord(record: FidelityRecord): record is ConvertedFidelityRecord {
  return record.pass !== null;
}

export function unconvertedFidelityRecord(doc: Pick<DocIR, 'pageId' | 'source'>, reason: UnconvertedReason): UnconvertedFidelityRecord {
  return { pageId: doc.pageId, source: doc.source, pass: null, reason };
}

export function fidelityRecordsPath(workspace: string): string {
  return join(workspace, 'inventory', 'fidelity.json');
}

export function writeFidelityRecords(workspace: string, records: FidelityRecord[]): void {
  const path = fidelityRecordsPath(workspace);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
}

/** Records of the last convert; none when convert has not run. */
export function readFidelityRecords(workspace: string): FidelityRecord[] {
  const path = fidelityRecordsPath(workspace);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as FidelityRecord[] : [];
}
