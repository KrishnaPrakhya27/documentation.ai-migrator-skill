/**
 * Which exactness proofs a source can be held to.
 *
 * Declared per source kind in code and never inferred from which evidence happens to
 * be missing. A proof that applies and lacks its evidence fails. A proof that does not
 * apply reports `inapplicable` with the reason written here, so a reviewer can see
 * exactly why a repository was not checked for rendered theme chrome, and nobody can
 * make a gate pass by deleting the file it reads.
 *
 * The rule every entry obeys: each source kind keeps at least one content witness.
 *
 * - A repository, export or API source served files, not pages. There is no rendered page to
 *   reconcile against and no platform theme around it, so `html-reconciliation` and
 *   `chrome-absent` do not apply. `source-content-exact` does, and reads the frozen file that
 *   `acquireNativePages` recorded.
 * - A live site publishing Markdown beside each page served both witnesses, so both apply.
 * - A live site publishing no Markdown served only the rendered page: `source-content-exact` has
 *   no authored file to read, so it does not apply, and `html-reconciliation` is the witness that
 *   must pass. Exempting the reconciliation instead would leave such a site with no content proof
 *   at all, which is how a gate stops meaning anything.
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
    reasons.set('html-reconciliation', `a ${context.kind} source serves files, not rendered pages; source-content-exact certifies its content against the frozen file`);
    reasons.set('chrome-absent', `a ${context.kind} source carries no platform theme chrome around its content`);
    return reasons;
  }
  if (!context.publishesMarkdown) {
    reasons.set('source-content-exact', 'this platform publishes no Markdown beside its pages, so the rendered page is the only content the source served; html-reconciliation certifies the output against it');
  }
  return reasons;
}
