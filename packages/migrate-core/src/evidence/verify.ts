import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../session/ids.js';
import { frozenFileDrift, readSourceManifest, sourceManifestHash, type SourceManifest } from './manifest.js';
import { accountSourceUniverse, readScopeDecisions, universeProblems, type UniversePage } from './scope.js';

/** Missing or changed evidence is an error even when there are no pages left in the editable plan. */
export function requireSourceManifest(workspace: string, pinnedHash: string | undefined): SourceManifest {
  if (!pinnedHash) throw new Error('no source manifest hash is pinned; discover in a new workspace with this migrator');
  if (sourceManifestHash(workspace) !== pinnedHash) throw new Error('source manifest is missing or changed after discover; use the original frozen workspace');
  const manifest = readSourceManifest(workspace)!;
  const drift = frozenFileDrift(workspace, manifest);
  if (manifest.source.kind === 'url' || manifest.source.kind === 'api') {
    const name = manifest.source.kind === 'url' ? 'discovery-result.json' : 'api-index.json';
    const path = join(workspace, 'source-cache', name);
    const expected = manifest.indexes.find((entry) => entry.location === name)?.sha256;
    if (!expected || !existsSync(path) || sha256(readFileSync(path)) !== expected) drift.push('frozen discovery result is missing or changed');
  }
  if (drift.length) throw new Error(`frozen source changed: ${drift.slice(0, 8).join('; ')}`);
  return manifest;
}

export function sourceUniverseProblems(input: { workspace: string; manifest: SourceManifest; treePages: readonly UniversePage[]; written: ReadonlySet<string>; quarantined: ReadonlySet<string> }): string[] {
  const decisions = readScopeDecisions(input.workspace);
  const account = accountSourceUniverse({ ...input, decisions });
  const issues = input.manifest.issues ?? [];
  // A help system the operator left out of this run answers the issue it raised: the observation
  // stays in the frozen manifest, and the attributed decision beside it says who resolved it and
  // how. A decision naming an issue this capture never recorded resolves nothing and is reported,
  // so a waiver cannot be carried across captures.
  const answered = new Set(decisions.helpSystems.filter((entry) => issues.includes(entry.issue)).map((entry) => entry.issue));
  const stale = decisions.helpSystems.filter((entry) => !issues.includes(entry.issue)).map((entry) => `${entry.root}: help system decision names an issue the frozen source manifest does not record`);
  return [
    ...issues.filter((issue) => !answered.has(issue)),
    ...stale,
    ...(!input.manifest.pages.length ? ['source manifest contains no page evidence'] : []),
    ...universeProblems(account),
    // Quarantine is an accounted failure, never permission to release an incomplete migration.
    ...(account.quarantined ? [`${account.quarantined} in-scope source pages remain quarantined`] : []),
  ];
}
