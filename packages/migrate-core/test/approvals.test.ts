import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateApproval, pinGateSubjects, releaseApprovalProblems, type GateApproval } from '../src/session/approvals.js';
import type { Session } from '../src/session/workspace.js';

const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dai-approvals-'));
  mkdirSync(join(root, 'report'));
  return root;
};

const approval = (root: string, gate: 3 | 4): GateApproval => ({ at: '2026-09-13T00:00:00.000Z', by: 'reviewer', pinned: pinGateSubjects(root, gate) });

describe('immutable pre-push and preview approvals', () => {
  it('keeps gate 3 valid when preview verification updates the current report', () => {
    const root = workspace();
    writeFileSync(join(root, 'report', 'pre-push-gates.json'), '{"pass":true}');
    const gate3 = approval(root, 3);
    writeFileSync(join(root, 'report', 'gates.json'), '{"pass":true,"phase":"preview"}');
    const session = { approvals: { 3: gate3 } } as Session;
    expect(gateApproval(root, session, 3)).toEqual({ approved: true });
  });

  it('allows all four approvals to hold simultaneously', () => {
    const root = workspace();
    for (const file of ['pre-push-gates.json', 'preview-gates.json', 'preview-routes.json', 'responsive.json']) writeFileSync(join(root, 'report', file), `{ "file": "${file}" }`);
    const prior = { at: '2026-09-13T00:00:00.000Z', by: 'reviewer', pinned: {} };
    const session = { approvals: { 1: prior, 2: prior, 3: approval(root, 3), 4: approval(root, 4) } } as Session;
    expect(releaseApprovalProblems(root, session, 4)).toEqual([]);
  });
});
