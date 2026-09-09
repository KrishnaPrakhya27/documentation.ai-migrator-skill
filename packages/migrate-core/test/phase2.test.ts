import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspace } from '../src/session/workspace.js';
import { Fetcher, type FetchImpl } from '../src/scrape/fetcher.js';
import { discoverLiveSite, normaliseDiscoveryUrl } from '../src/scrape/discovery.js';
import { getProfile } from '../src/scrape/profiles.js';
import { ingestAssets } from '../src/assets/providers.js';
import { sanitizeSvgBytes, writeManifest, readManifest, type AssetManifest } from '../src/assets/manifest.js';
import { writeCutoverArtifacts, canonicalUrl, runSearchCanary, writeDefaultSeoPlan } from '../src/report/cutover.js';
import { remoteOrg, assertRemoteAllowed } from '../src/write/migration-branch.js';
import type { Tree } from '../src/nav/tree.js';

const ws = () => { const w = mkdtempSync(join(tmpdir(), 'dai-p2-')); ensureWorkspace(w); return w; };

/** A fake site on a public IP literal so no DNS is needed; robots.txt 404 means "no rules". */
function fakeSite(pages: Record<string, string>): FetchImpl {
  return (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const body = pages[url.pathname];
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (body === undefined) return new Response('nope', { status: 404 });
    const type = url.pathname.endsWith('.xml') ? 'application/xml' : 'text/html; charset=utf-8';
    return new Response(body, { status: 200, headers: { 'content-type': type } });
  }) as unknown as FetchImpl;
}

describe('discovery', () => {
  it('normalises candidates: same origin only, hash and tracking params stripped, non-pages dropped', () => {
    const o = 'http://8.8.8.8';
    expect(normaliseDiscoveryUrl('/docs/a#x?utm_source=z', o + '/', o)).toBe('http://8.8.8.8/docs/a');
    expect(normaliseDiscoveryUrl('/docs/a?b=2&utm_campaign=q&a=1', o + '/', o)).toBe('http://8.8.8.8/docs/a?a=1&b=2');
    expect(normaliseDiscoveryUrl('https://other.example/docs', o + '/', o)).toBeUndefined();
    expect(normaliseDiscoveryUrl('/logo.png', o + '/', o)).toBeUndefined();
    expect(normaliseDiscoveryUrl('mailto:x@y', o + '/', o)).toBeUndefined();
  });
  it('unions sitemap, sidebar and link graph with provenance and respects the limit', async () => {
    const site = fakeSite({
      '/': '<html><title>Home | Site</title><nav><a href="/docs/a">A</a></nav><a href="/docs/b">B</a></html>',
      '/docs/a': '<html><title>A</title><a href="/docs/c">C</a><a href="https://elsewhere.example/x">ext</a></html>',
      '/docs/b': '<html><title>B</title></html>',
      '/docs/c': '<html><title>C</title><a href="/docs/a">back</a></html>',
      '/sitemap.xml': '<urlset><url><loc>http://8.8.8.8/docs/a</loc></url><url><loc>http://8.8.8.8/docs/d</loc></url></urlset>',
    });
    const fetcher = new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 });
    const r = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/', fetcher, profile: getProfile('generic') });
    const byUrl = Object.fromEntries(r.pages.map((p) => [p.url, p]));
    expect(Object.keys(byUrl).sort()).toEqual(['http://8.8.8.8/', 'http://8.8.8.8/docs/a', 'http://8.8.8.8/docs/b', 'http://8.8.8.8/docs/c', 'http://8.8.8.8/docs/d']);
    expect(byUrl['http://8.8.8.8/docs/a'].reasons).toEqual(['link-graph', 'sidebar', 'sitemap']);
    expect(byUrl['http://8.8.8.8/docs/c'].reasons).toEqual(['link-graph']);
    expect(byUrl['http://8.8.8.8/docs/d'].reasons).toEqual(['sitemap']);
    expect(byUrl['http://8.8.8.8/docs/a'].title).toBe('A');
    expect(r.failures).toEqual([]); // /docs/d 404s but a non-2xx page is skipped, not a failure
    const limited = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/', fetcher: new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), profile: getProfile('generic'), limit: 2 });
    expect(limited.pages.length).toBe(2);
    expect(limited.truncated).toBe(true);
  });
});

describe('asset providers', () => {
  const manifestWith = (w: string, status: AssetManifest['entries'][string]['status'] = 'downloaded'): AssetManifest => {
    const p = join(w, 'assets-ready', 'abc.png'); writeFileSync(p, Buffer.from('PNG'));
    const m: AssetManifest = { provider: 'local', entries: { abc: { hash: 'abc', sourceUrls: ['https://cdn.example/x.png'], localPath: p, bytes: 3, contentType: 'image/png', status, altMissing: 0 } }, byUrl: { 'https://cdn.example/x.png': 'abc' } };
    writeManifest(w, m); return m;
  };
  it('s3: uploads with an injected client, records the public URL, and checkpoints the manifest', async () => {
    const w = ws(); const sent: any[] = [];
    const client = { send: async (cmd: any) => { sent.push(cmd.input); return {}; } };
    const m = await ingestAssets(manifestWith(w), { workspace: w, provider: 's3', s3Client: client, s3: { bucket: 'b', region: 'auto', prefix: 'migrations/assets', publicBase: 'https://assets.example' } });
    expect(sent[0].Key).toBe('migrations/assets/abc.png');
    expect(sent[0].Metadata).toEqual({ sha256: 'abc' });
    expect(m.entries.abc.status).toBe('ingested');
    expect(m.entries.abc.finalUrl).toBe('https://assets.example/migrations/assets/abc.png');
    expect(readManifest(w).entries.abc.finalUrl).toBe('https://assets.example/migrations/assets/abc.png');
  });
  it('dai-api: presign → PUT → confirm, and reuses an existing upload on 409', async () => {
    const w = ws(); const calls: string[] = [];
    const fetchImpl = (async (input: any, init?: any) => {
      const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/upload-url')) return new Response(JSON.stringify({ uploadUrl: 'https://r2.example/signed', storagePath: 'org-1/doc-1/abc.png' }), { status: 200 });
      if (url === 'https://r2.example/signed') return new Response('', { status: 200 });
      if (url.endsWith('/confirm')) return new Response(JSON.stringify({ image: { publicUrl: 'https://blob-cdn.example/org-1/doc-1/abc.png' } }), { status: 200 });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const m = await ingestAssets(manifestWith(w), { workspace: w, provider: 'dai-api', fetchImpl, dai: { baseUrl: 'https://api.example', token: 't', organizationId: 'org-1', documentationId: 'doc-1' } });
    expect(m.entries.abc.finalUrl).toBe('https://blob-cdn.example/org-1/doc-1/abc.png');
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['POST', 'PUT', 'POST']);
    // 409 on presign → look up the existing object by hash
    const dup = (async (input: any) => {
      const url = String(input);
      if (url.endsWith('/upload-url')) return new Response('exists', { status: 409 });
      if (url.includes('/images?search=')) return new Response(JSON.stringify({ images: [{ fileHash: 'abc', publicUrl: 'https://blob-cdn.example/existing.png' }] }), { status: 200 });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const w2 = ws();
    const m2 = await ingestAssets(manifestWith(w2), { workspace: w2, provider: 'dai-api', fetchImpl: dup, dai: { baseUrl: 'https://api.example', token: 't', organizationId: 'org-1', documentationId: 'doc-1' } });
    expect(m2.entries.abc.finalUrl).toBe('https://blob-cdn.example/existing.png');
  });
  it('retries a failed entry that still has local bytes, and never leaves the manifest unwritten', async () => {
    const w = ws();
    let attempts = 0;
    const client = { send: async () => { attempts++; if (attempts === 1) throw new Error('transient'); return {}; } };
    const opts = { workspace: w, provider: 's3' as const, s3Client: client, s3: { bucket: 'b', region: 'auto', publicBase: 'https://assets.example' } };
    let m = await ingestAssets(manifestWith(w), opts);
    expect(m.entries.abc.status).toBe('failed');
    expect(m.entries.abc.error).toBe('transient');
    m = await ingestAssets(readManifest(w), opts);
    expect(m.entries.abc.status).toBe('ingested');
    expect(attempts).toBe(2);
  });
  it('none keeps sources external; local keeps downloaded entries without a final URL', async () => {
    const w = ws();
    expect((await ingestAssets(manifestWith(w), { workspace: w, provider: 'none' })).entries.abc.status).toBe('kept-external');
    const w2 = ws();
    const m = await ingestAssets(manifestWith(w2), { workspace: w2, provider: 'local' });
    expect(m.entries.abc.status).toBe('downloaded');
    expect(m.entries.abc.finalUrl).toBeUndefined();
  });
});

describe('svg sanitiser', () => {
  it('strips scripts, handlers, styles and external references but keeps drawing primitives', () => {
    const out = sanitizeSvgBytes(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()"><style>.a{}</style><script>alert(1)</script><a href="https://evil.example"><path d="M0 0h10" fill="red" style="x:y"/></a><use href="#p"/><use href="https://evil.example/x.svg#p"/><image href="data:image/png;base64,AAAA"/></svg>`)).toString();
    expect(out).not.toMatch(/script|onload|style=|evil\.example|<a\b|<image/);
    expect(out).toContain('<path d="M0 0h10" fill="red"');
    expect(out).toContain('<use href="#p"');
    expect(out.startsWith('<svg')).toBe(true);
    expect(() => sanitizeSvgBytes(Buffer.from('<!DOCTYPE svg><svg/>'))).toThrow(/DOCTYPE/);
    expect(() => sanitizeSvgBytes(Buffer.from('<div>not svg</div>'))).toThrow(/standalone SVG/);
  });
});

describe('cutover and canary', () => {
  const tree: Tree = { scope: 'full', platform: 'x', pages: [{ id: 'a', title: 'Install guide', source: 's', group: [], order: 0, oldPath: '/old/install', newPath: 'install', migrate: true }] };
  it('writes the runbook and sitemap list from the seo plan', () => {
    const w = ws();
    const seo = writeDefaultSeoPlan(w, 'https://help.example/docs');
    expect(seo.sourceBase).toBe('https://help.example');
    writeCutoverArtifacts(w, { tree, urlPlan: { mode: 'preserve', scope: 'full', preserve: { case: 'preserve' }, restructure: { strategy: 'from-nav' }, pages: [] }, exact: [{ source: '/old/install', destination: '/install', statusCode: 308 }], wildcard: [], seo: { ...seo, targetBase: 'https://docs.example' } });
    expect(readFileSync(join(w, 'report', 'sitemap.urls.txt'), 'utf8')).toBe('https://docs.example/install\n');
    const md = readFileSync(join(w, 'report', 'cutover.md'), 'utf8');
    expect(md).toContain('Exact redirects: 1');
    expect(md).toContain('365 days');
    expect(canonicalUrl('https://docs.example/base/', '/a/b')).toBe('https://docs.example/base/a/b');
  });
  it('search canary passes when the route or title is present and fails otherwise', async () => {
    const w = ws();
    const ok = new Fetcher({ workspace: w, rps: 1000, fetchImpl: fakeSite({ '/search': '<html>results: /install</html>' }) });
    const pass = await runSearchCanary({ workspace: w, tree, template: 'http://8.8.8.8/search?q={query}', fetcher: ok });
    expect(pass.pass).toBe(true);
    expect(existsSync(join(w, 'report', 'search-canary.json'))).toBe(true);
    const bad = new Fetcher({ workspace: ws(), rps: 1000, fetchImpl: fakeSite({ '/search': '<html>nothing</html>' }) });
    const fail = await runSearchCanary({ workspace: ws(), tree, template: 'http://8.8.8.8/search?q={query}', fetcher: bad });
    expect(fail.pass).toBe(false);
    expect(fail.failures[0].reason).toMatch(/absent/);
    await expect(runSearchCanary({ workspace: ws(), tree, template: 'http://8.8.8.8/search', fetcher: ok })).rejects.toThrow(/\{query\}/);
  });
});

describe('remote policy', () => {
  it('parses scp subgroups and binds the allowlist to host and org', () => {
    expect(remoteOrg('git@gitlab.com:acme/platform/docs.git')).toEqual({ host: 'gitlab.com', org: 'acme' });
    expect(remoteOrg('https://github.com/acme-docs/site.git/')).toEqual({ host: 'github.com', org: 'acme-docs' });
    expect(() => assertRemoteAllowed('https://evil.example/acme-docs/site.git', ['acme-docs'])).toThrow(/not in the allowed list/);
    expect(() => assertRemoteAllowed('https://github.com/acme-docs/site.git', ['acme-docs'])).not.toThrow();
    expect(() => assertRemoteAllowed('git@gitlab.com:acme/platform/docs.git', ['gitlab.com/acme'])).not.toThrow();
  });
});
