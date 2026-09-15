/**
 * The API specifications a source declares, captured whole before anything is converted.
 *
 * A reference section is content: the specs it renders are as much the customer's material as the
 * prose around them. They are captured as a graph with their references intact rather than
 * flattened, and pinned, so conversion cannot quietly rewrite an endpoint.
 *
 * Nothing here reads the command line or prints: the command supplies what the operator asked for
 * and reports what came back, so the capture can be run and tested on its own.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { frozenRootPath } from '../evidence/manifest.js';
import { captureSpecGraph, type SpecManifest } from '../openapi/graph.js';
import { readmeCatalogSpecs } from '../openapi/readme.js';
import { Fetcher } from '../scrape/fetcher.js';
import { fileHash, type Session } from '../session/workspace.js';
import type { Tree } from '../nav/tree.js';
import { readJson, writeJson } from './io.js';
import { readPlatformMeta } from './platform-meta.js';

/** Captures full spec graphs before conversion; private catalogs need an explicitly supplied export. */
export interface OpenapiCaptureInput {
  workspace: string;
  session: Session;
  tree: Tree;
  /** Specs the operator supplied, for a catalog that is not public. */
  supplied: string[];
  concurrency: number;
  fetcher: Fetcher;
}

export interface OpenapiCapture {
  /** Hash of the pinned manifest, or undefined when the source declares no specs. */
  hash?: string;
  documents: number;
  operations: number;
}

export async function captureOpenapi({ workspace, session, tree, supplied: suppliedSpecs, concurrency, fetcher }: OpenapiCaptureInput): Promise<OpenapiCapture> {
  const path = join(workspace, 'inventory', 'openapi.json');
  if (session.hashes.openapi) {
    if (!existsSync(path) || fileHash(path) !== session.hashes.openapi) throw new Error('OpenAPI manifest changed after acquisition');
    const pinned = readJson<SpecManifest>(path);
    return { hash: session.hashes.openapi, documents: pinned.documents.length, operations: pinned.operations.length };
  }
  const meta = readPlatformMeta(workspace);
  const supplied = suppliedSpecs.map((source) => /^https?:\/\//i.test(source) ? source : pathToFileURL(resolve(source)).toString());
  const frozenRoot = frozenRootPath(workspace);
  // Mintlify writes repository paths as "/api-reference/openapi.json"; they are relative to the repository, never the filesystem root
  const native = (meta.openapi ?? []).map((entry) => {
    if (/^https?:\/\//i.test(entry.spec)) return entry.spec;
    const file = resolve(frozenRoot, entry.spec.replace(/^\/+/, ''));
    if (!file.startsWith(frozenRoot + '/')) throw new Error(`openapi spec ${entry.spec} for group ${entry.groupPath.join(' / ')} points outside the source repository`);
    return pathToFileURL(file).toString();
  });
  let catalog: string[] = [];
  if (tree.platform === 'readme' && session.source.kind === 'url' && !supplied.length) {
    const catalogUrl = new URL('/.well-known/api-catalog', session.source.location).toString();
    const response = await fetcher.get(catalogUrl);
    if (response.status === 200) {
      writeFileSync(join(workspace, 'source-cache', 'readme-api-catalog.json'), response.body, { mode: 0o600 });
      catalog = readmeCatalogSpecs(response.body, catalogUrl);
    } else if (![404, 401, 403].includes(response.status)) throw new Error(`ReadMe API catalog returned HTTP ${response.status}`);
    writeJson(join(workspace, 'inventory', 'readme-api-catalog.json'), { url: catalogUrl, status: response.status, specs: catalog, ...(catalog.length ? {} : { issue: 'No public specs available; supply authorized exports with acquire --openapi <file-or-url>. API-reference completeness remains unproven.' }) });
  }
  const roots = [...new Set([...native, ...supplied, ...catalog])];
  if (!roots.length) return { documents: 0, operations: 0 };
  // native specs may reference anything in the frozen repository; a supplied spec only its own directory
  const localRoots = supplied.filter((url) => url.startsWith('file:')).map((url) => dirname(fileURLToPath(url)));
  if (native.some((url) => url.startsWith('file:'))) localRoots.push(frozenRoot);
  const manifest = await captureSpecGraph({ workspace, roots, concurrency, fetch: async (url) => {
    if (url.startsWith('file:')) {
      const file = resolve(fileURLToPath(url));
      if (!localRoots.some((root) => file.startsWith(root + '/')) || !/\.(?:json|ya?ml)$/i.test(file)) throw new Error(`OpenAPI file reference is outside supplied spec directories or has an unsupported extension: ${file}`);
      return { body: readFileSync(file, 'utf8'), status: 200, finalUrl: url };
    }
    if (!/^https?:\/\//i.test(url)) throw new Error(`unsupported OpenAPI source protocol: ${url}`);
    return fetcher.get(url);
  } });
  writeJson(path, manifest);
  if (meta.openapi?.length) {
    const rewritten = meta.openapi.map((entry, i) => {
      const url = new URL(native[i]); url.hash = '';
      return { ...entry, spec: `api-reference/${manifest.documents.find((document) => document.source === url.toString())!.file}` };
    });
    writeJson(join(workspace, 'inventory', 'platform-meta.json'), { ...meta, openapi: rewritten, openapiCaptured: true });
  }
  return { hash: fileHash(path), documents: manifest.documents.length, operations: manifest.operations.length };
}
