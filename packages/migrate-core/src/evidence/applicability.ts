/**
 * Design proposal only: not consumed by runGates. Do not enable these exemptions
 * until independent semantic witnesses are implemented and verified for each kind.
 *
 * Which exactness proofs a source can be held to.
 *
 * Declared per source kind in code and never inferred from which evidence happens to
 * be missing. A proof that applies and lacks its evidence fails. A proof that does not
 * apply reports `not-applicable` with the reason written here, so a reviewer can see
 * exactly why a repository was not checked for rendered theme chrome, and nobody can
 * make a gate pass by deleting the file it reads.
 */
import type { SourceKind } from './manifest.js';

export interface ProofContext {
  kind: SourceKind;
  /** The platform publishes Markdown beside each rendered page, so the rendered page is a second, independent witness. */
  publishesMarkdown: boolean;
}

export function inapplicableProofs(context: ProofContext): ReadonlyMap<string, string> {
  const reasons = new Map<string, string>();
  if (context.kind !== 'url') {
    reasons.set('html-reconciliation', `a ${context.kind} source has no rendered page to reconcile; source-witness-coverage counts the frozen source itself`);
    reasons.set('chrome-absent', `a ${context.kind} source carries no platform theme chrome`);
  } else if (!context.publishesMarkdown) {
    reasons.set('html-reconciliation', 'the rendered page is itself the content source for this platform; source-witness-coverage counts its DOM');
  }
  return reasons;
}
