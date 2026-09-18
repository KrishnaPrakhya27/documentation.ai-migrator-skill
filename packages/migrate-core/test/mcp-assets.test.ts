/**
 * Hosting pictures through a sign-in: the Authoring MCP server's import_media fetches each file
 * from its public address. These cover the batching and retries, which files must go as bytes
 * instead, and the size check that keeps exact mode from hosting a file other than the one captured.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestAssets, type McpToolCaller } from '../src/assets/providers.js';
import { readManifest, writeManifest, type AssetEntry, type AssetManifest } from '../src/assets/manifest.js';

const PROJECT = { organizationId: 'o1', documentationId: 'd1' };
const hosted = (name: string, project = PROJECT) => `https://blob-cdn.example/org-${project.organizationId}/doc-${project.documentationId}/1-${name}`;

function workspace(): string {
  const w = mkdtempSync(join(tmpdir(), 'dai-mcp-assets-'));
  mkdirSync(join(w, 'plan'), { recursive: true });
  mkdirSync(join(w, 'assets-ready'), { recursive: true });
  return w;
}

/** A manifest of downloaded assets; each file holds `size` bytes, so the size check has something to compare. */
function manifest(w: string, assets: Array<{ hash: string; url: string; size?: number; sanitized?: boolean; type?: string; status?: AssetEntry['status']; storagePath?: string }>): AssetManifest {
  const entries: Record<string, AssetEntry> = {};
  for (const asset of assets) {
    const localPath = join(w, 'assets-ready', `${asset.hash}.png`);
    writeFileSync(localPath, Buffer.alloc(asset.size ?? 3));
    entries[asset.hash] = {
      hash: asset.hash, sourceUrls: [asset.url], references: [], localPath, bytes: asset.size ?? 3,
      contentType: asset.type ?? 'image/png', status: asset.status ?? 'downloaded', altMissing: 0,
      ...(asset.sanitized ? { sanitized: true } : {}), ...(asset.storagePath ? { storagePath: asset.storagePath, finalUrl: `https://blob-cdn.example/${asset.storagePath}` } : {}),
    };
  }
  const m: AssetManifest = { provider: 'local', entries, byUrl: Object.fromEntries(assets.map((a) => [a.url, a.hash])) };
  writeManifest(w, m);
  return m;
}

/** A stand-in for import_media: stores each URL unless `refuse` says otherwise, answering in the real tool's shape. */
function server(options: { refuse?: (url: string, call: number) => string | undefined; size?: (url: string) => number } = {}) {
  const calls: Array<{ files: Array<{ url: string; name?: string }>; organizationId?: string; documentationId?: string }> = [];
  const client: McpToolCaller = {
    call: async (tool, args) => {
      if (tool !== 'import_media') throw new Error(`unexpected tool ${tool}`);
      calls.push(args as never);
      const files = (args.files as Array<{ url: string; name?: string }>);
      const imported: unknown[] = []; const failed: unknown[] = [];
      for (const file of files) {
        const refusal = options.refuse?.(file.url, calls.length);
        if (refusal) failed.push({ source: file.url, error: refusal });
        else imported.push({ source: file.url, url: hosted(file.name ?? 'x.png'), sizeBytes: options.size?.(file.url) ?? 3, reused: false });
      }
      // failures first: results must be matched by source, not by position
      return { structured: { imported, failed } as never, text: '' };
    },
  };
  return { client, calls };
}

const noWait = async () => {};

afterEach(() => { vi.useRealTimers(); });

describe('dai-mcp: hosting through a sign-in', () => {
  it('imports each file from its public address into the chosen project and records where it landed', async () => {
    const w = workspace();
    const { client, calls } = server();
    const m = await ingestAssets(manifest(w, [{ hash: 'a', url: 'https://docs.example/img/diagram.png' }]), {
      workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, sleep: noWait,
    });
    expect(calls).toEqual([{ files: [{ url: 'https://docs.example/img/diagram.png', name: 'diagram.png' }], ...PROJECT }]);
    expect(m.entries.a).toMatchObject({ status: 'ingested', finalUrl: hosted('diagram.png'), storagePath: 'org-o1/doc-d1/1-diagram.png' });
    expect(readManifest(w).entries.a.status).toBe('ingested');
  });

  it('sends no project ids when the session is a key already bound to one', async () => {
    const w = workspace();
    const { client, calls } = server();
    await ingestAssets(manifest(w, [{ hash: 'a', url: 'https://docs.example/a.png' }]), { workspace: w, provider: 'dai-mcp', mcp: { client }, sleep: noWait });
    expect(calls[0]).not.toHaveProperty('documentationId');
  });

  it('sends ten files per call, the most the tool takes, and paces calls under the platform rate', async () => {
    // A clock the sleeps move forward, as real ones would.
    vi.useFakeTimers({ now: 0, toFake: ['Date'] });
    const w = workspace(); const waits: number[] = [];
    const { client, calls } = server();
    const assets = Array.from({ length: 25 }, (_, i) => ({ hash: `h${i}`, url: `https://docs.example/${i}.png` }));
    const m = await ingestAssets(manifest(w, assets), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, sleep: async (ms) => { waits.push(ms); vi.setSystemTime(Date.now() + ms); } });
    expect(calls.map((c) => c.files.length)).toEqual([10, 10, 5]);
    expect(Object.values(m.entries).every((e) => e.status === 'ingested')).toBe(true);
    // 10 files at 120 a minute is one batch every 5 seconds
    expect(waits).toEqual([5000, 5000]);
  });

  it('matches each result to its file by source, whatever order the platform answers in', async () => {
    const w = workspace();
    const { client } = server({ refuse: (url) => (url.endsWith('b.png') ? 'Source answered 404' : undefined) });
    const m = await ingestAssets(manifest(w, [
      { hash: 'a', url: 'https://docs.example/a.png' },
      { hash: 'b', url: 'https://docs.example/b.png' },
      { hash: 'c', url: 'https://docs.example/c.png' },
    ]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, sleep: noWait });
    expect(m.entries.a).toMatchObject({ status: 'ingested', finalUrl: hosted('a.png') });
    expect(m.entries.b.status).toBe('failed');
    expect(m.entries.b.error).toMatch(/could not fetch it: Source answered 404.*project API key/);
    expect(m.entries.c).toMatchObject({ status: 'ingested', finalUrl: hosted('c.png') });
  });

  it('waits as told and retries a file refused for rate alone', async () => {
    const w = workspace(); const waits: number[] = [];
    const { client, calls } = server({ refuse: (_url, call) => (call === 1 ? 'Too many files stored for this organization. Retry in 12 seconds.' : undefined) });
    const m = await ingestAssets(manifest(w, [{ hash: 'a', url: 'https://docs.example/a.png' }]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, sleep: async (ms) => { waits.push(ms); } });
    expect(calls).toHaveLength(2);
    expect(waits).toContain(12_000);
    expect(m.entries.a.status).toBe('ingested');
  });

  it('records a call that failed outright against every file in it, and carries on', async () => {
    const w = workspace(); let n = 0;
    const client: McpToolCaller = { call: async () => { n += 1; if (n === 1) throw new Error('the Authoring MCP server answered HTTP 500'); return { structured: { imported: [], failed: [] } as never, text: '' }; } };
    const m = await ingestAssets(manifest(w, [{ hash: 'a', url: 'https://docs.example/a.png' }]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, sleep: noWait });
    expect(m.entries.a.status).toBe('failed');
    expect(m.entries.a.error).toMatch(/the Authoring MCP server answered HTTP 500/);
  });

  it('does nothing for files already hosted in this project, so a re-run makes no calls', async () => {
    const w = workspace();
    const { client, calls } = server();
    await ingestAssets(manifest(w, [{ hash: 'a', url: 'https://docs.example/a.png', status: 'ingested', storagePath: 'org-o1/doc-d1/1-a.png' }]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, sleep: noWait });
    expect(calls).toHaveLength(0);
  });

  it('imports again a file hosted under another project, once the migration points somewhere else', async () => {
    const w = workspace();
    const { client, calls } = server();
    const m = await ingestAssets(manifest(w, [{ hash: 'a', url: 'https://docs.example/a.png', status: 'ingested', storagePath: 'org-o1/doc-OLD/1-a.png' }]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, sleep: noWait });
    expect(calls).toHaveLength(1);
    expect(m.entries.a.storagePath).toBe('org-o1/doc-d1/1-a.png');
  });

  it('refuses to start without a signed-in session', async () => {
    const w = workspace();
    await expect(ingestAssets(manifest(w, [{ hash: 'a', url: 'https://docs.example/a.png' }]), { workspace: w, provider: 'dai-mcp', sleep: noWait })).rejects.toThrow(/signed-in Authoring MCP session/);
  });
});

describe('dai-mcp: files that must go as bytes', () => {
  /** A stand-in for POST /api/v1/media, for the files a URL cannot carry. */
  const restApi = () => {
    const uploads: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v1/media') && init?.method === 'POST') {
        const names = [...(init.body as FormData).getAll('files')].map((file) => (file as File).name);
        uploads.push(...names);
        return new Response(JSON.stringify({ results: names.map((name) => ({ source: name, status: 'added', media: { url: hosted(`bytes-${name}`), sizeBytes: 3 } })) }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, uploads, dai: { baseUrl: 'https://api.example', token: 'k' } };
  };

  it('fails a file with no public https address, and says a key would carry it', async () => {
    const w = workspace();
    const { client, calls } = server();
    const m = await ingestAssets(manifest(w, [{ hash: 'a', url: 'http://docs.example/a.png' }]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, sleep: noWait });
    expect(calls).toHaveLength(0);
    expect(m.entries.a.status).toBe('failed');
    expect(m.entries.a.error).toMatch(/no public https address.*project API key/);
  });

  it('uploads such a file with the key when one is set', async () => {
    const w = workspace();
    const { client } = server(); const api = restApi();
    const m = await ingestAssets(manifest(w, [{ hash: 'a', url: 'file:///export/media/a.png' }]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, dai: api.dai, fetchImpl: api.fetchImpl, sleep: noWait });
    expect(api.uploads).toEqual(['a.png']);
    expect(m.entries.a).toMatchObject({ status: 'ingested', finalUrl: hosted('bytes-a.png') });
  });

  it('uploads the captured copy of a file the platform could not fetch, when a key is set', async () => {
    const w = workspace();
    const { client } = server({ refuse: () => 'Source answered 404 Not Found.' }); const api = restApi();
    const m = await ingestAssets(manifest(w, [{ hash: 'a', url: 'https://docs.example/a.png' }]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, dai: api.dai, fetchImpl: api.fetchImpl, sleep: noWait });
    expect(api.uploads).toEqual(['a.png']);
    expect(m.entries.a).toMatchObject({ status: 'ingested', finalUrl: hosted('bytes-a.png') });
  });

  it('never imports a cleaned SVG by URL, since the source serves the unsafe original', async () => {
    const w = workspace();
    const { client, calls } = server();
    const m = await ingestAssets(manifest(w, [{ hash: 's', url: 'https://docs.example/logo.svg', sanitized: true, type: 'image/svg+xml' }]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, sleep: noWait });
    expect(calls).toHaveLength(0);
    expect(m.entries.s.error).toMatch(/cleaned of unsafe content/);
  });

  it('in exact mode, refuses a file the source now serves at a different size, and uploads the captured one with a key', async () => {
    const w = workspace();
    const { client } = server({ size: () => 999 }); const api = restApi();
    const refused = await ingestAssets(manifest(w, [{ hash: 'a', url: 'https://docs.example/a.png', size: 3 }]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, fidelityMode: 'exact', sleep: noWait });
    expect(refused.entries.a.status).toBe('failed');
    expect(refused.entries.a.error).toMatch(/serves 999 bytes where 3 were captured/);

    const w2 = workspace();
    const carried = await ingestAssets(manifest(w2, [{ hash: 'a', url: 'https://docs.example/a.png', size: 3 }]), { workspace: w2, provider: 'dai-mcp', mcp: { client, project: PROJECT }, dai: api.dai, fetchImpl: api.fetchImpl, fidelityMode: 'exact', sleep: noWait });
    expect(carried.entries.a).toMatchObject({ status: 'ingested', finalUrl: hosted('bytes-a.png') });
  });

  it('in permissive mode, hosts the source\'s current copy and notes the difference', async () => {
    const w = workspace();
    const { client } = server({ size: () => 999 });
    const m = await ingestAssets(manifest(w, [{ hash: 'a', url: 'https://docs.example/a.png', size: 3 }]), { workspace: w, provider: 'dai-mcp', mcp: { client, project: PROJECT }, fidelityMode: 'permissive', sleep: noWait });
    expect(m.entries.a.status).toBe('ingested');
    expect(m.entries.a.note).toMatch(/serves 999 bytes where 3 were captured/);
  });
});
