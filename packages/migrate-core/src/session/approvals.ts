/**
 * The four human gates, recorded rather than described.
 *
 * The gates existed only as printed prose: a stage announced "review this", and nothing stopped
 * the next stage from running, so a migration could reach a customer's repository with nobody
 * having approved anything. An approval is now a record in `session.json` that names who approved
 * what, and pins the state they saw.
 *
 * The pin is what makes it an approval rather than a checkbox. Gate 1 approves a scope, so it pins
 * `plan/tree.yaml`; gate 2 approves conversion decisions, so it pins the plan files; gate 3
 * approves an output, so it pins the immutable pre-push report that judged it; gate 4 pins the
 * immutable rendered-preview evidence. Edit the thing after approving it
 * and the approval no longer matches what exists, which reads as unapproved — the operator is told
 * exactly which file moved.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileHash, type Session } from './workspace.js';

export type GateNumber = 1 | 2 | 3 | 4;

export interface GateApproval {
  at: string;
  /** Who approved it: a person, recorded for the migration report and the audit trail. */
  by: string;
  note?: string;
  /** Hash of each file the approval covers, by workspace-relative path. */
  pinned: Record<string, string>;
}

export const GATE_NAMES: Record<GateNumber, string> = {
  1: 'scope and structure',
  2: 'conversion decisions',
  3: 'converted output, before any push',
  4: 'rendered preview, before release',
};

/** The files whose contents a gate's approval covers. A missing file is simply not pinned. */
export function gateSubjects(workspace: string, gate: GateNumber): string[] {
  const paths: Record<GateNumber, string[]> = {
    1: ['plan/tree.yaml', 'plan/scope-decisions.yaml'],
    2: ['plan/component-plan.yaml', 'plan/urls.yaml', 'plan/assets.yaml', 'plan/block-exclusions.yaml'],
    3: ['report/pre-push-gates.json'],
    4: ['report/preview-gates.json', 'report/preview-routes.json', 'report/responsive.json'],
  };
  return paths[gate].filter((relative) => existsSync(join(workspace, relative)));
}

export function pinGateSubjects(workspace: string, gate: GateNumber): Record<string, string> {
  return Object.fromEntries(gateSubjects(workspace, gate).map((relative) => [relative, fileHash(join(workspace, relative))]));
}

export interface ApprovalState {
  approved: boolean;
  /** Why it does not count: absent, or the files it covered have changed since. */
  problem?: string;
}

/** Whether a gate is approved for exactly the state that exists now. */
export function gateApproval(workspace: string, session: Session, gate: GateNumber): ApprovalState {
  const approval = session.approvals?.[gate];
  if (!approval) return { approved: false, problem: `human gate ${gate} (${GATE_NAMES[gate]}) has not been approved` };
  const moved = Object.entries(approval.pinned)
    .filter(([relative, hash]) => !existsSync(join(workspace, relative)) || fileHash(join(workspace, relative)) !== hash)
    .map(([relative]) => relative);
  const added = gateSubjects(workspace, gate).filter((relative) => !(relative in approval.pinned));
  if (moved.length || added.length) {
    return { approved: false, problem: `human gate ${gate} (${GATE_NAMES[gate]}) was approved by ${approval.by} at ${approval.at}, but ${[...moved, ...added].join(', ')} changed since; review and approve again` };
  }
  return { approved: true };
}

/** The gates that must hold before output may leave this workspace, in the order they are asked for. */
export function releaseApprovalProblems(workspace: string, session: Session, upTo: GateNumber): string[] {
  const gates: GateNumber[] = [1, 2, 3, 4];
  return gates.filter((gate) => gate <= upTo).map((gate) => gateApproval(workspace, session, gate).problem).filter((problem): problem is string => !!problem);
}
