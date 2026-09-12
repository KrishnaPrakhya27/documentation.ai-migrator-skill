import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSpecGraph, parseSpec, pointerValue, writeSpecOutput } from '../src/openapi/graph.js';
import { readmeCatalogSpecs } from '../src/openapi/readme.js';
import { sha256 } from '../src/session/ids.js';

const dirs: string[] = [];
const workspace = (): string => { const dir = mkdtempSync(join(tmpdir(), 'dai-openapi-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const url = 'https://example.test/spec.json';
const root = { openapi: '3.1.0', info: { title: 'Synthetic', version: '1' } };
const response = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });

describe('OpenAPI preservation', () => {
  it('retains composition, recursion, media types, examples, callbacks, security alternatives, extensions and deep schemas', async () => {
    const ws = workspace();
    let nested: unknown = { type: ['string', 'null'], enum: ['a', null], default: null, readOnly: true, pattern: '^a$', minLength: 1 };
    for (let i = 0; i < 20; i++) nested = { type: 'object', properties: { child: nested }, additionalProperties: false };
    const spec = { ...root, servers: [{ url: 'https://api.example.test/{version}', variables: { version: { default: 'v1' } } }],
      security: [{ key: [] }, { oauth: ['read'] }],
      paths: { '/items/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], post: { operationId: 'create', deprecated: true,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' }, examples: { data: { value: { $ref: 'literal-example-not-a-reference' } } } }, 'application/xml': { schema: { type: 'string' } } } },
        responses: { '200': { description: 'Success', headers: { 'x-id': { schema: { type: 'string' } } }, content: { 'application/json': { schema: nested }, 'text/plain': { example: 'hello' } } }, default: { description: 'Error' } },
        callbacks: { callback: { '{$request.body#/callback}': { post: { responses: { '204': { description: 'Done' } } } } } } }, trace: { responses: { '200': { description: 'Trace' } } } } },
      webhooks: { changed: { post: { operationId: 'changed', responses: { '200': { description: 'OK' } } } } },
      components: { schemas: { Node: { allOf: [{ type: 'object' }, { properties: { next: { $ref: '#/components/schemas/Node' } } }], oneOf: [{ type: 'string' }, { type: 'number' }], anyOf: [true, false] } }, securitySchemes: { key: { type: 'apiKey', in: 'cookie', name: 'session' }, oauth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://example.test/token', scopes: { read: 'Read' } } } } } },
      'x-readme': { samples: [{ language: 'java', code: 'authored code' }] },
    };
    const manifest = await captureSpecGraph({ workspace: ws, roots: [url], fetch: async () => response(spec) });
    writeSpecOutput(ws, manifest, join(ws, 'output'));
    const output = JSON.parse(readFileSync(join(ws, 'output/openapi', manifest.documents[0].file), 'utf8')) as unknown;
    expect(output).toEqual(spec);
    expect(manifest.operations.map((operation) => operation.method)).toEqual(['POST', 'TRACE', 'POST']);
    expect(readFileSync(join(ws, 'source-cache/openapi', `${sha256(url)}.source`), 'utf8')).toBe(JSON.stringify(spec));
  });

  it('captures external and circular references once and preserves reference siblings', async () => {
    const ws = workspace(); const shared = 'https://example.test/shared.yaml'; const calls: string[] = [];
    const graph: Record<string, string> = {
      [url]: JSON.stringify({ ...root, paths: {}, components: { schemas: { Node: { $ref: './shared.yaml#/$defs/Node', description: 'Sibling stays' } } } }),
      [shared]: '$defs:\n  Node:\n    type: object\n    properties:\n      next:\n        $ref: "./spec.json#/components/schemas/Node"\n',
    };
    const manifest = await captureSpecGraph({ workspace: ws, roots: [url], fetch: async (source) => { calls.push(source); return { status: 200, body: graph[source] }; } });
    expect(calls).toEqual([url, shared]);
    const compiled = JSON.parse(readFileSync(join(ws, 'source-cache/openapi', manifest.documents[0].file), 'utf8')) as { components: { schemas: { Node: { $ref: string; description: string } } } };
    expect(compiled.components.schemas.Node).toEqual({ $ref: `./${sha256(shared)}.json#/$defs/Node`, description: 'Sibling stays' });
  });

  it('handles escaped pointers, anchors and boolean schemas without defaulting to string', () => {
    expect(pointerValue({ 'a/b': { '~name': false } }, '#/a~1b/~0name')).toBe(false);
    expect(pointerValue({ schemas: { Node: { $anchor: 'node', type: 'object' } } }, '#node')).toEqual({ $anchor: 'node', type: 'object' });
    expect(() => pointerValue({}, '#/missing')).toThrow(/missing/);
    expect(() => parseSpec('default: 9007199254740993')).toThrow(/precision/);
  });

  it('makes relative server URLs absolute against the original spec origin', async () => {
    const ws = workspace();
    const manifest = await captureSpecGraph({ workspace: ws, roots: [url], fetch: async () => response({ ...root, paths: {}, servers: [{ url: '/v1' }] }) });
    expect(readFileSync(join(ws, 'source-cache/openapi', manifest.documents[0].file), 'utf8')).toContain('https://example.test/v1');
  });

  it.each([
    { ...root, paths: {}, components: { schemas: { Missing: { $ref: '#/missing' } } } },
    { ...root, paths: {}, components: { schemas: { Resource: { $id: 'resource.json' } } } },
    { ...root, paths: { '/a': { get: { operationId: 'duplicate' }, post: { operationId: 'duplicate' } } } },
    { swagger: '2.0', info: root.info, paths: {} },
  ])('fails explicitly for unresolved or unsupported specs %#', async (spec) => {
    await expect(captureSpecGraph({ workspace: workspace(), roots: [url], fetch: async () => response(spec) })).rejects.toThrow();
  });

  it('fetches shared spec dependencies concurrently within the configured bound', async () => {
    const ws = workspace(); let active = 0; let peak = 0;
    const roots = Array.from({ length: 24 }, (_, i) => `https://example.test/${i}.json`);
    const manifest = await captureSpecGraph({ workspace: ws, roots, concurrency: 8, fetch: async () => {
      active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 0)); active--;
      return response({ ...root, paths: {} });
    } });
    expect(peak).toBe(8); expect(manifest.documents.map((document) => document.source)).toEqual(roots);
  });

  it('reads ReadMe catalog links and refuses malformed or credential-bearing entries', () => {
    expect(readmeCatalogSpecs(JSON.stringify({ linkset: [{ anchor: 'https://example.test', 'service-desc': [{ href: '/spec.json' }] }] }), 'https://example.test/.well-known/api-catalog')).toEqual([url]);
    expect(() => readmeCatalogSpecs('{}', url)).toThrow(/linkset/);
    expect(() => readmeCatalogSpecs(JSON.stringify({ linkset: [{ 'service-desc': [{ href: 'https://user:secret@example.test/spec' }] }] }), url)).toThrow(/credential-free/);
  });
});
