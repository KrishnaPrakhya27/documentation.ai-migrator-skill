/** Freeze OpenAPI documents as a reference graph. Never flatten schemas or select a single media type. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sha256 } from '../session/ids.js';
import { mapConcurrent } from '../scrape/concurrency.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
export interface SpecDocument { source: string; sourceHash: string; outputHash: string; file: string; references: Array<{ pointer: string; target: string }> }
export interface SpecOperation { spec: string; kind: 'path' | 'webhook'; path: string; method: string; operationId?: string; pointer: string }
export interface SpecManifest { version: 1; roots: string[]; documents: SpecDocument[]; operations: SpecOperation[] }
export interface SpecFetchResult { body: string; finalUrl?: string; status: number }
export interface SpecGraphInput { workspace: string; roots: string[]; fetch: (url: string) => Promise<SpecFetchResult>; concurrency?: number; maxDocuments?: number; maxBytes?: number }
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const escapePointer = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');
const obj = (value: Json | undefined): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const documentUrl = (url: string): string => { const parsed = new URL(url); parsed.hash = ''; return parsed.toString(); };
const fileFor = (url: string): string => `${sha256(url)}.json`;
/** The file a captured spec is written to, by the URL it was captured from. */
export const capturedSpecFile = fileFor;

/** Where a spec lives in the output: the platform reads specifications from `api-reference/`. */
export function specOutputPath(spec: string): string {
  const clean = spec.replace(/^\.?\/+/, '');
  return clean.startsWith('api-reference/') ? clean : `api-reference/${clean}`;
}

function jsonValue(value: unknown, seen = new Set<unknown>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('OpenAPI integer exceeds lossless JavaScript precision');
    return Number(value);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('OpenAPI must contain JSON-compatible values; cyclic YAML aliases are unsupported (use $ref)');
  seen.add(value);
  const result = Array.isArray(value) ? value.map((entry) => jsonValue(entry, seen)) : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, seen)]));
  seen.delete(value); return result;
}

export function parseSpec(source: string): Json {
  return jsonValue(parseYaml(source, { intAsBigInt: true, maxAliasCount: 100 }));
}

/** References in authored example payloads are data, not schema references. */
function rewriteDocument(value: Json, base: string, references: SpecDocument['references'], rewrite: boolean, path: string[] = []): Json {
  if (Array.isArray(value)) return value.map((entry, i) => rewriteDocument(entry, base, references, rewrite, [...path, String(i)]));
  const node = obj(value); if (!node) return value;
  const schemaMap = ['properties', 'patternProperties', 'schemas', '$defs', 'definitions'].includes(path.at(-1) ?? '');
  const exampleObject = path.at(-2) === 'examples';
  return Object.fromEntries(Object.entries(node).map(([key, child]): [string, Json] => {
    if (!schemaMap && (key === 'example' || key === 'default' || key === 'const' || key === 'enum' || key.startsWith('x-') || key === 'examples' && Array.isArray(child) || exampleObject && key === 'value')) return [key, child];
    if (key === '$id' && typeof child === 'string') throw new Error(`${base}#/${path.join('/')}: schema $id relocation requires explicit resource mapping`);
    if (key === 'externalValue' && typeof child === 'string') throw new Error(`${base}: external example ${child} must be captured as an asset before relocating this spec`);
    if (['$ref', '$dynamicRef', 'operationRef'].includes(key) && typeof child === 'string') {
      const target = new URL(child, base);
      if (!['https:', 'http:', 'file:'].includes(target.protocol)) throw new Error(`${base}: unsupported reference protocol in ${child}`);
      references.push({ pointer: '/' + [...path, key].map(escapePointer).join('/'), target: target.toString() });
      return [key, rewrite ? `${documentUrl(target.toString()) === base ? '' : './' + fileFor(documentUrl(target.toString()))}${target.hash}` : child];
    }
    if (key === 'url' && path.at(-2) === 'servers' && typeof child === 'string' && !/^(?:[a-z][a-z0-9+.-]*|\{[^}]+\}):\/\//i.test(child)) {
      if (base.startsWith('file:')) throw new Error(`${base}: relative server URL ${child} needs its published source origin`);
      return [key, rewrite ? new URL(child, base).toString() : child];
    }
    return [key, rewriteDocument(child, base, references, rewrite, [...path, key])];
  }));
}

export function pointerValue(document: Json, fragment: string): Json {
  if (!fragment || fragment === '#') return document;
  const pointer = decodeURIComponent(fragment.replace(/^#/, ''));
  if (!pointer.startsWith('/')) {
    const matches: Json[] = [];
    const scan = (value: Json): void => {
      if (Array.isArray(value)) { value.forEach(scan); return; }
      const record = obj(value); if (!record) return;
      if (record.$anchor === pointer || record.$dynamicAnchor === pointer) matches.push(value);
      Object.values(record).forEach(scan);
    };
    scan(document);
    if (matches.length !== 1) throw new Error(`OpenAPI anchor ${fragment} resolves to ${matches.length} targets`);
    return matches[0];
  }
  let value: Json | undefined = document;
  for (const key of pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (Array.isArray(value)) value = /^\d+$/.test(key) ? value[Number(key)] : undefined;
    else { const record = obj(value); value = record && Object.hasOwn(record, key) ? record[key] : undefined; }
    if (value === undefined) throw new Error(`OpenAPI reference target missing: ${fragment}`);
  }
  return value;
}

export async function captureSpecGraph(input: SpecGraphInput): Promise<SpecManifest> {
  const dir = join(input.workspace, 'source-cache', 'openapi'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const roots = [...new Set(input.roots.map(documentUrl))];
  const pending = [...roots]; const documents = new Map<string, SpecDocument>(); const queued = new Set(roots);
  const maxDocuments = input.maxDocuments ?? 2000; const maxBytes = input.maxBytes ?? 256 * 1024 * 1024;
  let bytes = 0;
  const read = (url: string): Json => parseSpec(readFileSync(join(dir, `${sha256(url)}.source`), 'utf8'));
  while (pending.length) {
    const batch = pending.splice(0, input.concurrency ?? 8);
    if (documents.size + batch.length > maxDocuments) throw new Error(`OpenAPI graph exceeds ${maxDocuments} documents`);
    const responses = await mapConcurrent(batch, input.concurrency ?? 8, async (url) => ({ url, response: await input.fetch(url) }));
    for (const { url, response } of responses) {
      if (response.status < 200 || response.status >= 300) throw new Error(`OpenAPI ${url}: HTTP ${response.status}; supply an authorized spec export if downloads are restricted`);
      if (response.finalUrl && documentUrl(response.finalUrl) !== url) throw new Error(`OpenAPI ${url} redirects to ${response.finalUrl}; use the final declared spec URL to preserve relative references`);
      bytes += Buffer.byteLength(response.body);
      if (bytes > maxBytes) throw new Error(`OpenAPI graph exceeds ${maxBytes} bytes`);
      const parsed = parseSpec(response.body);
      if (roots.includes(url) && !/^3\.(?:0|1)\./.test(String(obj(parsed)?.openapi ?? ''))) throw new Error(`${url}: target migration currently supports OpenAPI 3.0 and 3.1; Swagger 2 / other versions require a lossless version adapter`);
      const references: SpecDocument['references'] = [];
      const output = JSON.stringify(rewriteDocument(parsed, url, references, true), null, 2) + '\n';
      const file = fileFor(url);
      const sourceFile = join(dir, `${sha256(url)}.source`);
      if (existsSync(sourceFile) && readFileSync(sourceFile, 'utf8') !== response.body) throw new Error(`${url}: source spec changed during this capture; start a new workspace`);
      writeFileSync(sourceFile, response.body, { mode: 0o600 });
      writeFileSync(join(dir, file), output, { mode: 0o600 });
      documents.set(url, { source: url, sourceHash: sha256(response.body), outputHash: sha256(output), file, references });
      for (const ref of references) {
        const target = documentUrl(ref.target);
        if (!queued.has(target)) { queued.add(target); pending.push(target); }
      }
    }
  }
  // Resolve references without expanding them: recursive graphs and composition remain intact.
  for (const document of documents.values()) for (const reference of document.references) {
    const target = new URL(reference.target);
    try { pointerValue(read(documentUrl(reference.target)), target.hash); }
    catch (error) { throw new Error(`${document.source}${reference.pointer}: ${(error as Error).message}`); }
  }
  const operations: SpecOperation[] = [];
  for (const root of roots) {
    const document = obj(read(root))!; const operationIds = new Set<string>();
    for (const [container, kind] of [['paths', 'path'], ['webhooks', 'webhook']] as const) {
      for (const [path, value] of Object.entries(obj(document[container]) ?? {})) {
        if (path.startsWith('x-')) continue;
        let item = obj(value); const seen = new Set<string>(); let base = root;
        while (typeof item?.$ref === 'string') {
          const target = new URL(item.$ref, base);
          if (seen.has(target.toString())) throw new Error(`${root}: cyclic path-item reference for ${path}`);
          seen.add(target.toString()); base = documentUrl(target.toString());
          const resolved = obj(pointerValue(read(base), target.hash));
          const siblings = Object.fromEntries(Object.entries(item).filter(([key]) => key !== '$ref'));
          if (Object.keys(siblings).some((key) => resolved && key in resolved)) throw new Error(`${root}: conflicting path-item $ref siblings at ${path}`);
          item = { ...resolved, ...siblings };
        }
        for (const method of METHODS) {
          const operation = obj(item?.[method]); if (!operation) continue;
          const operationId = typeof operation.operationId === 'string' ? operation.operationId : undefined;
          if (operationId && operationIds.has(operationId)) throw new Error(`${root}: duplicate operationId ${operationId}`);
          if (operationId) operationIds.add(operationId);
          operations.push({ spec: root, kind, path, method: method.toUpperCase(), operationId, pointer: `#/${container}/${escapePointer(path)}/${method}` });
        }
      }
    }
  }
  return { version: 1, roots, documents: [...documents.values()], operations };
}

export function writeSpecOutput(workspace: string, manifest: SpecManifest, outputDir: string): void {
  const dir = join(outputDir, 'api-reference'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const document of manifest.documents) {
    if (document.file !== fileFor(document.source)) throw new Error('OpenAPI manifest contains an invalid output path');
    const source = readFileSync(join(workspace, 'source-cache', 'openapi', `${sha256(document.source)}.source`));
    const compiled = readFileSync(join(workspace, 'source-cache', 'openapi', document.file));
    if (sha256(source) !== document.sourceHash || sha256(compiled) !== document.outputHash) throw new Error(`${document.source}: frozen OpenAPI bytes changed`);
    writeFileSync(join(dir, document.file), compiled, { mode: 0o600 });
  }
}
