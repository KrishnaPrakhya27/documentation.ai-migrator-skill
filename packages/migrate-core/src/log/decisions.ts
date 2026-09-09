/**
 * Decision log: every non-identical transformation, every AI proposal, every
 * lossy step. JSONL, append-only, redacted. Stores hashes and source spans by
 * default; full original content only when `--log-originals` is set.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { redact } from './redact.js';
import { shortHash } from '../session/ids.js';

export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7';

export interface Decision {
  at: string;
  stage: 'acquire' | 'inventory' | 'plan' | 'convert' | 'assets' | 'nav' | 'urls' | 'write' | 'verify';
  pageId?: string;
  sourceNodeId?: string;
  signature?: string;
  tier?: Tier;
  rule?: string;
  lossy?: string[];
  confidence?: number;
  originalHash?: string;
  originalSpan?: { file: string; line?: number };
  original?: string;
  outputHash?: string;
  output?: string;
  reviewedBy?: string;
  note?: string;
}

export class DecisionLog {
  private path: string;
  constructor(workspace: string, private logOriginals = false) {
    this.path = join(workspace, 'logging', 'decisions.jsonl');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
  }

  record(d: Omit<Decision, 'at'> & { original?: string; output?: string }): void {
    const entry: Decision = { at: new Date().toISOString(), ...d };
    if (d.original !== undefined) {
      entry.originalHash = shortHash(d.original);
      if (!this.logOriginals) delete entry.original; else entry.original = redact(d.original);
    }
    if (d.output !== undefined) {
      entry.outputHash = shortHash(d.output);
      if (!this.logOriginals) delete entry.output; else entry.output = redact(d.output);
    }
    if (entry.note) entry.note = redact(entry.note);
    appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
}
