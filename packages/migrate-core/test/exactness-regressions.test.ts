import { describe, expect, it } from 'vitest';
import { validateNavigation } from '@dai/content-contract';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import { documentImages, documentLinks, htmlReconciliation, chromeAbsent } from '../src/verify/source-truth.js';
import { getProfile } from '../src/scrape/profiles.js';
import { walkBlocks } from '../src/ir/types.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquiredPath, acquirePages } from '../src/scrape/acquire.js';
import type { FetchedPage } from '../src/scrape/fetcher.js';
import { mapConcurrent } from '../src/scrape/concurrency.js';

const options = { platform: 'generic', file: 'synthetic.md', pageId: 'synthetic' };

describe('source constructs cannot disappear in a shared parser', () => {
  it('resolves full, collapsed and shortcut references, including table cells and reference images', () => {
    const source = '[Full][ref] **[ref][]** [ref]\n\n![alt][image]\n\n| Link | Image |\n| --- | --- |\n| *[ref]* | ![cell][image] |\n\n[ref]: https://example.com/guide "Guide"\n[image]: https://example.com/image.png "Image"\n';
    const parsed = markdownToIr(source, options);
    const output = markdownToIr(docToMdx(parsed), { ...options, platform: 'dai' });
    expect(documentLinks(parsed)).toEqual(Array(4).fill('https://example.com/guide'));
    expect(documentImages(parsed).map((image) => image.alt)).toEqual(['alt', 'cell']);
    expect(documentLinks(output)).toEqual(documentLinks(parsed));
    expect(documentImages(output)).toEqual(documentImages(parsed));
  });

  it('stops on unsupported footnotes instead of dropping their markers and flattening their bodies', () => {
    expect(() => markdownToIr('Text[^note]\n\n[^note]: Authored body\n', options)).toThrow(/synthetic.md:.*unsupported Markdown node footnoteReference/);
  });

  it('assigns distinct ledger identities to repeated snippet uses', () => {
    const doc = markdownToIr('import Shared from "/snippets/shared.mdx";\n\n<Shared />\n\n<Shared />', { ...options, platform: 'mintlify', resolveSnippet: () => 'Shared content' });
    const ids: string[] = [];
    walkBlocks(doc.children, (node) => { ids.push(node.id); });
    expect(doc.children).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports recursive snippet imports before overflowing the stack', () => {
    const source = 'import Shared from "/snippets/shared.mdx";\n\n<Shared />';
    expect(() => markdownToIr(source, { ...options, resolveSnippet: () => source })).toThrow(/recursive snippet import/);
  });
});

describe('navigation follows renderer container rules', () => {
  const page = { title: 'Guide', path: 'guide' };
  const check = (navigation: unknown) => validateNavigation({ name: 'Synthetic', navigation }, (path) => path === 'guide');

  it('accepts a tab holding dropdowns, and a dropdown holding dropdowns, as the platform does', () => {
    expect(check({ tabs: [{ tab: 'Learn', dropdowns: [{ dropdown: 'Guides', pages: [page] }, { dropdown: 'Lessons', href: 'https://learn.example/' }] }] })).toEqual([]);
    expect(check({ dropdowns: [{ dropdown: 'Docs', dropdowns: [{ dropdown: 'Nested', pages: [page] }] }] })).toEqual([]);
  });

  it('accepts languages containing versions, tabs and menus', () => {
    expect(check({ languages: [{ language: 'ar', versions: [{ version: 'v1', tabs: [{ tab: 'Docs', menus: [{ menu: 'Guide', pages: [page] }] }] }] }] })).toEqual([]);
  });

  it.each([
    { products: [{ product: 'Product', languages: [{ language: 'ar', pages: [page] }] }] },
    { versions: [{ version: 'v1', languages: [{ language: 'ar', pages: [page] }] }] },
    { groups: [{ group: 'Docs', tabs: [{ tab: 'Nested', pages: [page] }] }] },
    { tabs: [{ tab: 'Docs', versions: [{ version: 'v1', pages: [page] }] }] },
  ])('rejects invalid nesting %#', (navigation) => {
    expect(check(navigation).some((issue) => issue.message.includes('cannot contain'))).toBe(true);
  });
});

describe('missing evidence cannot pass', () => {
  const page = { pageId: 'p', path: '/guide', route: 'guide', outputFile: '/not-present.mdx' };
  it('requires rendered HTML for HTML reconciliation', () => {
    expect(htmlReconciliation(page, 'readme', getProfile('readme'))).toMatchObject({ pass: false, detail: 'no rendered HTML was frozen for this page' });
  });
  it('requires a nonempty chrome profile', () => {
    expect(chromeAbsent(page, [])).toMatchObject({ pass: false, detail: 'no platform chrome evidence was supplied' });
  });
});

describe('bounded, resumable acquisition', () => {
  it('acquires 1500 synthetic pages with bounded parallelism and resumes without refetching successes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dai-scale-'));
    const pages = Array.from({ length: 1500 }, (_, index) => ({ id: `p${index}`, title: `Page ${index}`, source: `https://example.com/docs/p${index}`, group: [], order: index, migrate: true }));
    let active = 0; let peak = 0; let requests = 0; let broken = true;
    const fetcher = { async get(url: string): Promise<FetchedPage> {
      requests++; active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      const markdown = url.endsWith('.md');
      return { url, finalUrl: url, status: broken && url.endsWith('/p1200.md') ? 503 : 200, contentType: markdown ? 'text/markdown' : 'text/html', body: markdown ? '# Synthetic\n\nAuthored text.\n' : '<main><h1>Synthetic</h1><p>Authored text.</p></main>', fetchedAt: '2026-01-01', fromCache: false };
    } };
    const input = { workspace, pages, fetcher, profile: getProfile('readme'), fidelityMode: 'exact' as const, concurrency: 8 };
    await expect(acquirePages(input)).rejects.toThrow(/p1200/);
    expect(peak).toBe(8);
    expect(requests).toBe(3000);
    broken = false; requests = 0;
    const resumed = await acquirePages(input);
    expect(requests).toBe(2);
    expect(resumed.pages.map((page) => page.id)).toEqual(pages.map((page) => page.id));
    const path = acquiredPath(workspace, 'p12');
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...record, markdown: 'tampered' }));
    requests = 0;
    await acquirePages(input);
    expect(requests).toBe(2);
  });

  it('rejects invalid concurrency before starting work', async () => {
    await expect(mapConcurrent([1], 0, async (item) => item)).rejects.toThrow(/concurrency/);
  });
});
