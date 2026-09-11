/**
 * Firecrawl rejects a batch scrape that requests zero data retention on an account
 * without a ZDR agreement, so retention is requested only when asked for.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Firecrawl } from '../src/scrape/firecrawl.js';

/** Captures the batch-scrape request body, then fails the call so the test never reaches polling. */
function captureBatchBody(): { bodies: Array<Record<string, unknown>> } {
  const captured = { bodies: [] as Array<Record<string, unknown>> };
  vi.stubGlobal('fetch', async (_input: unknown, init?: { body?: string }) => {
    captured.bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return new Response('stopped by test', { status: 500 });
  });
  return captured;
}

const workspace = () => mkdtempSync(join(tmpdir(), 'dai-firecrawl-'));

describe('Firecrawl zero data retention', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not request retention unless the caller opts in', async () => {
    const captured = captureBatchBody();
    await expect(new Firecrawl({ apiKey: 'test-key', workspace: workspace() }).batchScrape(['https://docs.example/a'])).rejects.toThrow(/500/);
    expect(captured.bodies[0].zeroDataRetention).toBe(false);
  });

  it('requests retention when the caller opts in', async () => {
    const captured = captureBatchBody();
    await expect(new Firecrawl({ apiKey: 'test-key', workspace: workspace(), zeroDataRetention: true }).batchScrape(['https://docs.example/a'])).rejects.toThrow(/500/);
    expect(captured.bodies[0].zeroDataRetention).toBe(true);
  });

  it('keeps the other customer-content safeguards regardless of retention', async () => {
    const captured = captureBatchBody();
    await expect(new Firecrawl({ apiKey: 'test-key', workspace: workspace() }).batchScrape(['https://docs.example/a'])).rejects.toThrow(/500/);
    expect(captured.bodies[0]).toMatchObject({ ignoreInvalidURLs: false, skipTlsVerification: false, storeInCache: false, maxAge: 0 });
    expect(captured.bodies[0]).toMatchObject({ formats: ['rawHtml', 'links'], onlyMainContent: false });
  });
});

describe('large resumable Firecrawl jobs', () => {
  it('persists 1500 pages, resumes an interrupted cursor without a second POST, and returns summaries', async () => {
    const dir = workspace();
    const urls = Array.from({ length: 1500 }, (_, i) => `https://example.test/p${i}`);
    let posts = 0; let reads = 0; let interrupted = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'POST') { posts++; return Response.json({ success: true, id: 'synthetic' }); }
      reads++;
      const offset = Number(new URL(String(input)).searchParams.get('offset') ?? 0);
      if (offset === 100 && !interrupted) { interrupted = true; throw new Error('simulated connection interruption'); }
      return Response.json({ status: 'completed', total: 1500, completed: 1500,
        next: offset + 100 < 1500 ? `https://api.firecrawl.dev/v2/batch/scrape/synthetic?offset=${offset + 100}` : undefined,
        data: urls.slice(offset, offset + 100).map((url) => ({ rawHtml: `<main>${url}</main>`, metadata: { sourceURL: url, statusCode: 200 } })),
      });
    };
    const client = () => new Firecrawl({ apiKey: 'synthetic', workspace: dir, maxConcurrency: 16, retainBodies: false, fetchImpl });
    await expect(client().batchScrape(urls)).rejects.toThrow(/interruption/);
    const pages = await client().batchScrape(urls);
    expect(posts).toBe(1);
    expect(pages.map((page) => page.url)).toEqual(urls);
    expect(pages.every((page) => page.html === undefined)).toBe(true);
    const before = reads;
    expect(await client().batchScrape(urls)).toEqual(pages);
    expect(reads).toBe(before);
  });

  it('rejects incomplete vendor counts even when the requested URL is present', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => init?.method === 'POST'
      ? Response.json({ success: true, id: 'synthetic' })
      : Response.json({ status: 'completed', total: 2, completed: 1, data: [{ rawHtml: '<main />', metadata: { sourceURL: 'https://example.test/a', statusCode: 200 } }] });
    await expect(new Firecrawl({ apiKey: 'synthetic', workspace: workspace(), fetchImpl }).batchScrape(['https://example.test/a'])).rejects.toThrow(/counts differ/);
  });
});
