/**
 * Search metadata is content the source published about itself. Losing it costs the customer
 * traffic on the day their domain moves, and nothing was capturing it: every migrated page carried
 * `title` and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSeo, seoFrontmatter } from '../src/scrape/seo.js';
import { retargetDocLinks } from '../src/urls/site-links.js';
import { rewriteAssetRefs } from '../src/assets/manifest.js';
import { sourceMetadataExact, type RawSourcePage } from '../src/verify/source-truth.js';
import type { AssetManifest } from '../src/assets/manifest.js';
import type { DocIR } from '../src/ir/types.js';

const page = 'https://docs.old.example/guides/install';
const html = (head: string): string => `<html><head>${head}</head><body><h1>Install</h1></body></html>`;

describe('what a page states about itself', () => {
  it('reads the canonical, social metadata and robots directive, resolved against the page', () => {
    expect(extractSeo(html('<link rel="canonical" href="/guides/install"/>'
      + '<meta property="og:title" content="Install the CLI"/>'
      + '<meta property="og:description" content="Every install path"/>'
      + '<meta property="og:image" content="../img/social.png"/>'
      + '<meta name="robots" content="noindex, follow"/>'), page)).toEqual({
      canonical: 'https://docs.old.example/guides/install',
      ogTitle: 'Install the CLI',
      ogDescription: 'Every install path',
      ogImage: 'https://docs.old.example/img/social.png',
      robots: 'noindex, follow',
    });
  });

  it('states nothing when the page states nothing', () => {
    expect(extractSeo(html('<title>Install</title>'), page)).toEqual({});
  });
});

describe('the frontmatter that keeps those statements', () => {
  const base = { url: page, title: 'Install', description: 'How to install' };

  it('writes no canonical for a page that points at itself', () => {
    // copying the old address would name the customer's dead site as the real one
    expect(seoFrontmatter({ canonical: 'https://docs.old.example/guides/install/' }, base, () => undefined)).toEqual({});
  });

  it('keeps a canonical that names another page, following it to where that page now lives', () => {
    const retarget = (url: string) => url === 'https://docs.old.example/guides/setup' ? '/guides/setup' : undefined;
    expect(seoFrontmatter({ canonical: 'https://docs.old.example/guides/setup' }, base, retarget)).toEqual({ canonical: '/guides/setup' });
    // a target outside the migration keeps the address it had, which still resolves
    expect(seoFrontmatter({ canonical: 'https://blog.old.example/post' }, base, () => undefined)).toEqual({ canonical: 'https://blog.old.example/post' });
    expect(seoFrontmatter({ canonical: 'https://docs.old.example/Guides/Install' }, base, () => undefined)).toEqual({ canonical: 'https://docs.old.example/Guides/Install' });
  });

  it('writes social metadata only where it differs from the page title and description', () => {
    expect(seoFrontmatter({ ogTitle: 'Install', ogDescription: 'How to install' }, base, () => undefined)).toEqual({});
    expect(seoFrontmatter({ ogTitle: 'Install the CLI', ogImage: 'https://docs.old.example/s.png' }, base, () => undefined))
      .toEqual({ metaTitle: 'Install the CLI', ogImage: 'https://docs.old.example/s.png' });
  });
});

describe('the canonical and the social image travel with the migration', () => {
  const doc = (frontmatter: Record<string, unknown>): DocIR => ({
    pageId: 'p', platform: 'generic', source: page, frontmatter: { title: 'Install', ...frontmatter }, children: [],
  } as unknown as DocIR);

  it('retargets a canonical like any other link between pages', () => {
    const out = retargetDocLinks(doc({ canonical: 'https://docs.old.example/guides/setup' }), (url) => url.replace('https://docs.old.example', ''));
    expect(out.frontmatter.canonical).toBe('/guides/setup');
  });

  it('hosts the social image instead of leaving it on the platform being left', () => {
    const manifest = { provider: 'local', entries: { a1: { finalUrl: '/img/social.png' } }, byUrl: { 'https://docs.old.example/s.png': 'a1' } } as unknown as AssetManifest;
    expect(rewriteAssetRefs(doc({ ogImage: 'https://docs.old.example/s.png' }), manifest).frontmatter.ogImage).toBe('/img/social.png');
  });
});

describe('robots directives are release evidence', () => {
  const compare = (robots: string) => {
    const workspace = mkdtempSync(join(tmpdir(), 'dai-robots-'));
    const outputFile = join(workspace, 'install.mdx');
    writeFileSync(outputFile, '---\ntitle: Install\n---\n\nBody.\n');
    const source: RawSourcePage = {
      pageId: 'p', path: '/install', route: 'install', outputFile, url: page, title: 'Install',
      html: html(`<meta name="robots" content="${robots}"/>`),
    };
    try { return sourceMetadataExact(source); } finally { rmSync(workspace, { recursive: true, force: true }); }
  };

  it('blocks a directive the target cannot preserve instead of silently dropping it', () => {
    expect(compare('noindex, follow')).toMatchObject({ pass: false, detail: expect.stringContaining('no supported Documentation.AI page mapping') });
  });

  it('accepts the default index/follow behavior', () => {
    expect(compare('index, follow')).toMatchObject({ pass: true });
  });
});

describe('a social card the platform generates', () => {
  it('is branding and is not carried, while an authored one is', () => {
    const page = { url: 'https://acme.example/docs/guide', title: 'Guide', description: 'A guide.' };
    const generated = { ogImage: 'https://acme.mintlify.app/_next/image?url=%2F_mintlify%2Fapi%2Fog%3Ftitle%3DGuide%26theme%3Dabc' };
    // baked with the source's own theme: the migrated site states its own, as with a logo or favicon
    expect(seoFrontmatter(generated, page, () => undefined, '/_mintlify/api/og').ogImage).toBeUndefined();
    // without the platform's generator declared, nothing is assumed
    expect(seoFrontmatter(generated, page, () => undefined).ogImage).toBe(generated.ogImage);
    // an image the author chose is a statement about the page and is carried
    const authored = { ogImage: 'https://acme.example/images/guide-card.png' };
    expect(seoFrontmatter(authored, page, () => undefined, '/_mintlify/api/og').ogImage).toBe(authored.ogImage);
  });
});
