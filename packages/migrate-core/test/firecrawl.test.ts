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
  });
});
