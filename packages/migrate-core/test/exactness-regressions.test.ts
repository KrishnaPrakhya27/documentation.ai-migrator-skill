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

  it('carries footnotes as footnotes: the marker stays a marker and the body stays a note', () => {
    const doc = markdownToIr('Text[^note]\n\n[^note]: Authored body\n', options);
    expect(doc.children[0]).toMatchObject({ type: 'paragraph', children: [{ type: 'text', value: 'Text' }, { type: 'footnoteReference', identifier: 'note' }] });
    expect(doc.children[1]).toMatchObject({ type: 'footnoteDefinition', identifier: 'note', children: [{ type: 'paragraph' }] });
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

  // The grammar is read from the platform's published schema (products > versions > languages >
  // tabs > dropdowns > menus > groups > pages): a version holds languages, never the reverse.
  it('accepts versions containing languages, tabs and menus', () => {
    expect(check({ versions: [{ version: 'v1', languages: [{ language: 'ar', tabs: [{ tab: 'Docs', menus: [{ menu: 'Guide', pages: [page] }] }] }] }] })).toEqual([]);
    expect(check({ products: [{ product: 'Product', languages: [{ language: 'ar', pages: [page] }] }] })).toEqual([]);
  });

  it('accepts a menu that is only an external link, as the schema does', () => {
    expect(check({ tabs: [{ tab: 'Learn', menus: [{ menu: 'Lessons', href: 'https://learn.example/' }, { menu: 'Guides', pages: [page] }] }] })).toEqual([]);
  });

  it.each([
    { languages: [{ language: 'ar', versions: [{ version: 'v1', pages: [page] }] }] },
    { groups: [{ group: 'Docs', tabs: [{ tab: 'Nested', pages: [page] }] }] },
    { tabs: [{ tab: 'Docs', versions: [{ version: 'v1', pages: [page] }] }] },
    { tabs: [{ tab: 'Docs', menus: [{ menu: 'Guide', dropdowns: [{ dropdown: 'Nested', pages: [page] }] }] }] },
  ])('rejects invalid nesting %#', (navigation) => {
    expect(check(navigation).some((issue) => issue.message.includes('cannot contain'))).toBe(true);
  });

  it('refuses what the renderer would ignore in silence: an icon it cannot draw, a method it does not know, a property of another kind', () => {
    expect(check({ pages: [{ ...page, icon: 'book-open', method: 'POST', 'content-width': 'wide', 'show-toc': false }] })).toEqual([]);
    expect(check({ pages: [{ ...page, icon: 'file-braces' }] })[0].message).toMatch(/icon "file-braces" is not a name the renderer/);
    expect(check({ pages: [{ ...page, method: 'FETCH' }] })[0].message).toMatch(/method "FETCH"/);
    expect(check({ tabs: [{ tab: 'Docs', description: 'Only a dropdown or a menu has one', pages: [page] }] })[0].message).toMatch(/"description" is not a tab property/);
    expect(check({ pages: [{ ...page, href: 'https://x.example/' }] })[0].message).toMatch(/both "path" and "href"/);
  });

  it('lets a container that opens its own page state that page\'s display options', () => {
    expect(check({ groups: [{ group: 'Guide', path: 'guide', 'show-sidebar': false, pages: [] }] }).filter((issue) => /show-sidebar/.test(issue.message))).toEqual([]);
    expect(check({ groups: [{ group: 'Guide', 'show-sidebar': false, pages: [page] }] })[0].message).toMatch(/"show-sidebar" is not a group property/);
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
