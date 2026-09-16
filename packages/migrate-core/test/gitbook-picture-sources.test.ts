import { describe, it, expect } from 'vitest';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { collectAssets } from '../src/assets/manifest.js';
import { isGitbookInternalFileRef } from '../src/ir/gitbook-html.js';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = (body: string, platform = 'gitbook') =>
  markdownToIr(`---\ntitle: T\n---\n\n${body}\n`, { platform, file: 'p.md', pageId: 'p' });

/** The srcset candidates the reader kept on the single image of a document. */
const variants = (doc: ReturnType<typeof read>): string[] => {
  const out: string[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.type === 'image' && Array.isArray(n.sources)) out.push(...n.sources);
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(doc.children);
  return out;
};

const imageUrls = (doc: ReturnType<typeof read>): string[] => {
  const out: string[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.type === 'image' && typeof n.url === 'string') out.push(n.url);
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(doc.children);
  return out;
};

const PICTURE = [
  '<picture>',
  '<source srcset="/files/QLUQj6waZRiK6FpSqrt6" media="(prefers-color-scheme: dark)">',
  '<img src="https://2111890564-files.gitbook.io/~/files/v0/b/x/o/options-menu.svg?alt=media&amp;token=3ee40bbf" alt="The Options menu icon">',
  '</picture>',
].join('');

describe('isGitbookInternalFileRef', () => {
  it('names the internal id form and nothing that has a real address', () => {
    expect(isGitbookInternalFileRef('/files/QLUQj6waZRiK6FpSqrt6')).toBe(true);
    // GitBook also writes the id as a hex digest
    expect(isGitbookInternalFileRef('/files/7357cbc20caed26a09fecd954050d03fafe931e0')).toBe(true);
    expect(isGitbookInternalFileRef('https://gitbook.com/files/QLUQj6waZRiK6FpSqrt6')).toBe(false);
    expect(isGitbookInternalFileRef('/files/a/b.png')).toBe(false);
    expect(isGitbookInternalFileRef('/assets/logo.svg')).toBe(false);
    expect(isGitbookInternalFileRef('https://2111890564-files.gitbook.io/~/files/v0/o/x.svg')).toBe(false);
  });
});

describe('GitBook <picture> dark-mode variants', () => {
  it('drops the internal-id candidate and keeps the image the page shows', () => {
    const doc = read(PICTURE);
    expect(imageUrls(doc)).toEqual(['https://2111890564-files.gitbook.io/~/files/v0/b/x/o/options-menu.svg?alt=media&token=3ee40bbf']);
    expect(variants(doc)).toEqual([]);
  });

  it('never asks the asset stage to host a URL GitBook publishes nowhere', async () => {
    const doc = read(PICTURE);
    const ws = mkdtempSync(join(tmpdir(), 'gb-picture-'));
    mkdirSync(join(ws, 'plan'), { recursive: true });
    const refs = await collectAssets([{ ...doc, source: 'https://gitbook.com/docs/create-content/blocks' } as any], ws, { provider: 'none' } as any);
    const urls = Object.keys(refs.byUrl ?? {}).concat(Object.values(refs.entries ?? {}).flatMap((e: any) => e.sourceUrls));
    expect(urls.some((u) => u.includes('/files/QLUQj6waZRiK6FpSqrt6'))).toBe(false);
  });

  it('keeps a srcset candidate that does have an address', () => {
    const doc = read(
      '<picture>' +
        '<source srcset="https://2111890564-files.gitbook.io/~/files/v0/o/dark.svg" media="(prefers-color-scheme: dark)">' +
        '<img src="https://2111890564-files.gitbook.io/~/files/v0/o/light.svg" alt="x">' +
        '</picture>',
    );
    expect(variants(doc)).toEqual(['https://2111890564-files.gitbook.io/~/files/v0/o/dark.svg']);
  });

  it('is GitBook-specific: another platform keeps its own /files/ candidate', () => {
    const doc = read(
      '<picture>' +
        '<source srcset="/files/QLUQj6waZRiK6FpSqrt6" media="(prefers-color-scheme: dark)" />' +
        '<img src="https://cdn.example.com/light.svg" alt="x" />' +
        '</picture>',
      'generic',
    );
    expect(variants(doc)).toEqual(['/files/QLUQj6waZRiK6FpSqrt6']);
  });
});
