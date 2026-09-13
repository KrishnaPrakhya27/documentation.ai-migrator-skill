/** Bind completed HTTP/API acquisition to discovery and the session, not to self-reported page hashes. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquiredPath, type AcquiredPage } from '../scrape/acquire.js';
import { sha256 } from '../session/ids.js';
import { sourceFingerprint } from '../scrape/drift.js';
import { assertRelativeSourcePath, sourceManifestHash, type SourceManifest } from './manifest.js';

interface AcquisitionIndex { sourceManifest: string; pages: Array<{ pageId: string; source: string; sha256: string }> }
const indexPath = (workspace: string): string => join(workspace, 'source-cache', 'acquisition-index.json');

export interface AcquisitionPin {
  hash: string;
  /** Pages the source changed between discovery and acquisition, so the two reads disagree. */
  drifted: Array<{ pageId: string; source: string }>;
}

export function pinAcquisition(workspace: string, manifest: SourceManifest, pages: ReadonlyArray<{ id: string; source: string }>, requireMarkdown: boolean): AcquisitionPin {
  const byId = new Map(manifest.pages.map((page) => [page.pageId, page]));
  const index: AcquisitionIndex = { sourceManifest: sourceManifestHash(workspace)!, pages: [] };
  if (!index.sourceManifest) throw new Error('cannot pin acquisition before source discovery is pinned');
  const seen = new Set<string>();
  const drifted: AcquisitionPin['drifted'] = [];
  for (const page of [...pages].sort((a, b) => a.id.localeCompare(b.id))) {
    assertRelativeSourcePath(page.id);
    if (page.id.includes('/') || seen.has(page.id)) throw new Error(`invalid or duplicate acquired page identity: ${page.id}`);
    seen.add(page.id);
    if (byId.get(page.id)?.location !== page.source) throw new Error(`${page.source}: acquired identity does not match the source manifest`);
    const raw = readFileSync(acquiredPath(workspace, page.id));
    const record = JSON.parse(raw.toString('utf8')) as AcquiredPage;
    if (record.url !== page.source) throw new Error(`${page.source}: acquired record belongs to ${record.url}`);
    if (record.html === undefined && record.markdown === undefined) throw new Error(`${page.source}: acquisition has no raw content`);
    for (const field of ['html', 'markdown'] as const) {
      const body = record[field];
      if (body !== undefined && (typeof body !== 'string' || record[`${field}Sha256`] !== sha256(body))) throw new Error(`${page.source}: missing or incorrect ${field} checksum`);
    }
    if (manifest.source.kind === 'url' && record.html === undefined) throw new Error(`${page.source}: acquisition has no rendered HTML`);
    // The page as discovery saw it, against the page as acquisition saw it. A difference here is
    // the customer publishing during the run; it is reported so the operator can decide, never
    // mixed into the output silently.
    const sourceHash = byId.get(page.id)?.rawSha256;
    if (sourceHash) {
      const acquired = record.html !== undefined ? sha256(sourceFingerprint(record.html)) : sha256(record.markdown!);
      if (acquired !== sourceHash) drifted.push({ pageId: page.id, source: page.source });
    }
    if (requireMarkdown && record.markdown === undefined) throw new Error(`${page.source}: published Markdown is required before acquisition can be pinned`);
    index.pages.push({ pageId: page.id, source: page.source, sha256: sha256(raw) });
  }
  const body = JSON.stringify(index, null, 2) + '\n';
  const path = indexPath(workspace);
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== body) throw new Error('acquisition is already pinned; use a new workspace for a new capture or expanded scope');
  } else {
    writeFileSync(`${path}.tmp`, body, { mode: 0o600 }); renameSync(`${path}.tmp`, path);
  }
  return { hash: sha256(body), drifted };
}

export function requireAcquisition(workspace: string, manifest: SourceManifest, pinnedHash: string | undefined, requiredPages: ReadonlyArray<{ id: string; migrate: boolean }> = []): void {
  if (manifest.source.kind === 'repo' || manifest.source.kind === 'export') return;
  const path = indexPath(workspace);
  if (!pinnedHash || !existsSync(path) || sha256(readFileSync(path)) !== pinnedHash) throw new Error('acquisition index is missing, changed or unpinned; complete acquisition with this migrator');
  const index = JSON.parse(readFileSync(path, 'utf8')) as AcquisitionIndex;
  if (index.sourceManifest !== sourceManifestHash(workspace) || !Array.isArray(index.pages)) throw new Error('acquisition does not belong to the frozen source manifest');
  const acquired = new Set<string>();
  for (const page of index.pages) {
    assertRelativeSourcePath(page.pageId);
    if (page.pageId.includes('/') || acquired.has(page.pageId)) throw new Error('acquisition index has invalid or duplicate identities');
    acquired.add(page.pageId);
    const file = acquiredPath(workspace, page.pageId);
    if (!existsSync(file) || sha256(readFileSync(file)) !== page.sha256) throw new Error(`${page.source}: acquired bytes changed after the session pinned them`);
  }
  for (const page of requiredPages) if (page.migrate && !acquired.has(page.id)) throw new Error(`${page.id}: in-scope source page has no pinned acquisition`);
}
