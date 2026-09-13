/**
 * The navigation a frozen repository declares, read again at verification time.
 *
 * A live site is re-read from its frozen pages, so the written navigation is judged against the
 * source rather than against the tree the same run produced. A repository had no equivalent: its
 * navigation was read once at discovery and never checked again, so `navigation-exact` had nothing
 * to compare against and failed every repository migration with "no independently extracted source
 * navigation was supplied".
 *
 * The witness is the source's own configuration — `docs.json`, `SUMMARY.md`, the ReadMe category
 * frontmatter — read by the same adapter that read it at discovery, from the frozen bytes. Running
 * the adapter again is what makes this independent of the tree: an operator edit to
 * `plan/tree.yaml` moves the output, and this witness does not move with it.
 *
 * A source that declares no navigation of its own returns nothing. That is not a failure here: a
 * generic repository's groups come from directory names, which is inference rather than a
 * statement by the source, and `source-navigation-proven` is where that is judged.
 */
import { adapterFor } from '../adapters/registry.js';
import type { SourceNavigationNode } from '../nav/tree.js';

export interface NativeNavigationWitness {
  nodes: SourceNavigationNode[];
  /** Where the statement was read from, recorded in the gate detail. */
  source: 'source-config';
}

/** Re-reads the navigation the frozen repository declares, or nothing when it declares none. */
export function nativeNavigationWitness(platform: string, root: string): NativeNavigationWitness | undefined {
  try {
    const nodes = adapterFor(root, platform)?.navigationWitness(root);
    return nodes?.length ? { nodes, source: 'source-config' } : undefined;
  } catch {
    // An unreadable configuration is not a witness. The gate then reports that the navigation
    // could not be re-read, which is the honest outcome; it is never treated as agreement.
    return undefined;
  }
}
