import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTruth, resolveSourceTruthDir, SOURCE_TRUTH_ENV, type SourceTruth, type SourceTruthPage } from './helpers/source-truth.js';
import { FIXTURE_APP_ORIGIN, FIXTURE_SITE_ORIGIN, fixtureFetcher, syntheticSiteFetcher } from './helpers/fixture-fetcher.js';

const HOME_HTML = '<html><head><title>Acme Docs</title></head><body><h1>Acme Docs</h1></body></html>';
const HOME_MD = '# Acme Docs\n\n> Welcome to Acme.\n';
const SETUP_HTML = '<html><head><title>Setup</title></head><body><h1>Setup</h1></body></html>';
const SETUP_MD = '# Setup\n\n> Install Acme.\n\nRun the installer.\n';
const ROBOTS = 'User-agent: *\nSitemap: https://acme.example/sitemap.xml\n';
const SITEMAP = '<?xml version="1.0"?><urlset><url><loc>https://acme.example/</loc></url><url><loc>https://acme.example/guides/setup</loc></url></urlset>';
const LLMS = '# Acme Docs\n\n- [Acme Docs](https://acme.example/index.md): Welcome to Acme.\n- [Setup](https://acme.example/guides/setup.md): Install Acme.\n';

function syntheticPage(path: string, title: string, description: string, groupPath: string[]): SourceTruthPage {
  const href = path === '/' ? '/index' : path;
  return {
    path, mdUrl: `https://acme.example${href}.md`, htmlUrl: `https://acme.example${path}`, title, description,
    llmsTxt: { title, description }, htmlTitleTag: `${title} - Acme Docs`,
    pageMetadata: { title, description, href }, sidebarLabel: title, groupPath,
    placements: [{ groupPath, sidebarLabel: title, navTitle: title, navDescription: description }],
    counts: { paragraphs: 1, topLevelParagraphs: 1, listItems: 0, boldSpans: 0, brTags: 0, linkCount: 0, mdBytes: 40, bodyNonEmptyLines: 2 },
    headings: { h1: 1 }, headingList: [{ level: 1, text: title }], links: [], images: [], videos: [], codeBlocks: [], components: {}, componentDetail: {},
    sidebarLabelSource: 'scopedNav title', placementsNote: null, groupEyebrowInHtml: groupPath[0] ?? null,
  };
}

function syntheticTruth(): SourceTruth {
  return {
    site: { name: 'Acme Docs', theme: 'plain', colors: { primary: '#112233', light: '#ffffff', dark: '#000000' }, favicon: 'https://acme.example/favicon.svg', logo: { light: 'https://acme.example/light.svg', dark: 'https://acme.example/dark.svg' }, navbarLinks: [{ href: 'https://x.com', label: 'Follow' }], footerSocials: { x: 'https://x.com' } },
    pageCount: 2,
    pages: [syntheticPage('/', 'Acme Docs', 'Welcome to Acme.', ['Welcome']), syntheticPage('/guides/setup', 'Setup', 'Install Acme.', ['Guides'])],
    navigationHierarchy: [{ group: 'Welcome', pages: [{ href: '/index', sidebarTitle: 'Acme Docs' }] }, { group: 'Guides', pages: [{ href: '/guides/setup', sidebarTitle: 'Setup' }] }],
    navigationNotes: [], paginationSequence: ['/', '/guides/setup'],
    paginationPerPage: { '/': { prev: null, next: ['Setup', '/guides/setup'] }, '/guides/setup': { prev: ['Acme Docs', '/'], next: null } },
    uiChromeStringsInHtml: {
      note: 'Strings rendered by the theme, not authored content.',
      header: ['Skip to main content', 'Follow (navbar link -> https://x.com; from docs.json navbar.links, config not content)'],
      sidebar: ['group labels: Welcome, Guides'],
      contentArea: ['group eyebrow above H1 (e.g. "Welcome", "Guides")', 'Steps numbering "1".."3" (Steps component chrome)', 'Expand image (image lightbox button aria-label)'],
      pagination: ['Pagination (aria-label)', 'Previous: <sidebarTitle> / Next: <sidebarTitle> (aria-labels)'],
      assistant: ['⌘I (shortcut hint, rendered as "⌘" + "I")', 'Responses are generated using AI and may contain mistakes.'],
      meta: ['meta generator=Acme'],
      notPresentInThisTheme: ['"Copy page"'],
    },
    htmlVsMd: {}, authoringAnomalies: { note: 'none' }, files: {},
  };
}

function writeSourceLayout(truth: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'dai-truth-'));
  mkdirSync(join(dir, 'html/guides'), { recursive: true });
  mkdirSync(join(dir, 'md/guides'), { recursive: true });
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth));
  writeFileSync(join(dir, 'llms.txt'), LLMS);
  writeFileSync(join(dir, 'robots.txt'), ROBOTS);
  writeFileSync(join(dir, 'sitemap.xml'), SITEMAP);
  writeFileSync(join(dir, 'html/index.html'), HOME_HTML);
  writeFileSync(join(dir, 'html/guides/setup.html'), SETUP_HTML);
  writeFileSync(join(dir, 'md/index.md'), HOME_MD);
  writeFileSync(join(dir, 'md/guides/setup.md'), SETUP_MD);
  return dir;
}

const originalTruthDir = process.env[SOURCE_TRUTH_ENV];
afterEach(() => {
  if (originalTruthDir === undefined) delete process.env[SOURCE_TRUTH_ENV];
  else process.env[SOURCE_TRUTH_ENV] = originalTruthDir;
});

describe('syntheticSiteFetcher', () => {
  const site = () => syntheticSiteFetcher({ host: 'acme.example', pages: { '/': { html: HOME_HTML, md: HOME_MD }, '/guides/setup': { html: SETUP_HTML, md: SETUP_MD } } });

  it('serves HTML and published Markdown for a two-page site and records every request in order', async () => {
    const fetcher = site();
    const home = await fetcher.fetch('https://acme.example/');
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await home.text()).toBe(HOME_HTML);
    const homeMarkdown = await fetcher.fetch('https://acme.example/index.md');
    expect(homeMarkdown.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await homeMarkdown.text()).toBe(HOME_MD);
    expect(await (await fetcher.fetch(new URL('https://acme.example/guides/setup'))).text()).toBe(SETUP_HTML);
    expect(await (await fetcher.fetch('https://acme.example/guides/setup.md')).text()).toBe(SETUP_MD);
    expect((await fetcher.fetch('https://acme.example/guides/missing')).status).toBe(404);
    expect((await fetcher.fetch('https://acme.example/guides/missing.md')).status).toBe(404);
    expect(fetcher.requests).toEqual([
      'https://acme.example/', 'https://acme.example/index.md', 'https://acme.example/guides/setup',
      'https://acme.example/guides/setup.md', 'https://acme.example/guides/missing', 'https://acme.example/guides/missing.md',
    ]);
  });

  it('serves robots, sitemap and llms documents only when the spec provides them', async () => {
    const bare = site();
    expect((await bare.fetch('https://acme.example/robots.txt')).status).toBe(404);
    expect((await bare.fetch('https://acme.example/sitemap.xml')).status).toBe(404);
    expect((await bare.fetch('https://acme.example/llms.txt')).status).toBe(404);
    const documented = syntheticSiteFetcher({ host: 'acme.example', pages: {}, robotsTxt: ROBOTS, sitemapXml: SITEMAP, llmsTxt: LLMS, llmsFullTxt: '# Acme Docs\n' });
    expect(await (await documented.fetch('https://acme.example/robots.txt')).text()).toBe(ROBOTS);
    const sitemap = await documented.fetch('https://acme.example/sitemap.xml');
    expect(sitemap.headers.get('content-type')).toBe('application/xml');
    expect(await sitemap.text()).toBe(SITEMAP);
    expect(await (await documented.fetch('https://acme.example/llms.txt')).text()).toBe(LLMS);
    expect(await (await documented.fetch('https://acme.example/llms-full.txt')).text()).toBe('# Acme Docs\n');
  });

  it('answers 404 for any other host', async () => {
    const fetcher = site();
    expect((await fetcher.fetch('https://other.example/')).status).toBe(404);
    expect(fetcher.requests).toEqual(['https://other.example/']);
  });
});

describe('fixtureFetcher', () => {
  it('serves the saved layout under both demo hosts', async () => {
    const dir = writeSourceLayout({});
    const { fetch, requests } = fixtureFetcher(dir);
    expect(await (await fetch(`${FIXTURE_SITE_ORIGIN}/`)).text()).toBe(HOME_HTML);
    expect(await (await fetch(`${FIXTURE_APP_ORIGIN}/index.md`)).text()).toBe(HOME_MD);
    expect(await (await fetch(`${FIXTURE_SITE_ORIGIN}/guides/setup`)).text()).toBe(SETUP_HTML);
    expect(await (await fetch(`${FIXTURE_APP_ORIGIN}/guides/setup.md`)).text()).toBe(SETUP_MD);
    expect(await (await fetch(`${FIXTURE_SITE_ORIGIN}/robots.txt`)).text()).toBe(ROBOTS);
    expect(await (await fetch(`${FIXTURE_APP_ORIGIN}/sitemap.xml`)).text()).toBe(SITEMAP);
    expect(await (await fetch(`${FIXTURE_APP_ORIGIN}/llms.txt`)).text()).toBe(LLMS);
    expect(requests).toHaveLength(7);
  });

  it('answers 404 for unknown pages, the truth file, path traversal and foreign hosts', async () => {
    const { fetch } = fixtureFetcher(writeSourceLayout({}));
    for (const url of [
      `${FIXTURE_SITE_ORIGIN}/guides/missing`, `${FIXTURE_SITE_ORIGIN}/guides/missing.md`, `${FIXTURE_SITE_ORIGIN}/truth.json`,
      `${FIXTURE_SITE_ORIGIN}/guides/`, `${FIXTURE_SITE_ORIGIN}/..%2Ftruth.json`, `${FIXTURE_SITE_ORIGIN}/html/index.html`, 'https://acme.example/',
    ]) expect((await fetch(url)).status, url).toBe(404);
  });

  it('refuses an incomplete layout with a message naming the variable and the missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dai-truth-empty-'));
    expect(() => fixtureFetcher(dir)).toThrow(new RegExp(`${SOURCE_TRUTH_ENV}.*missing truth\\.json, llms\\.txt, robots\\.txt, sitemap\\.xml, html/, md/`));
  });
});

describe('resolveSourceTruthDir', () => {
  it('throws naming DAI_SOURCE_TRUTH_DIR when the variable is unset', () => {
    delete process.env[SOURCE_TRUTH_ENV];
    expect(() => resolveSourceTruthDir()).toThrow(/DAI_SOURCE_TRUTH_DIR is not set/);
  });

  it('throws naming DAI_SOURCE_TRUTH_DIR and the missing files when it points at an empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dai-truth-empty-'));
    process.env[SOURCE_TRUTH_ENV] = dir;
    expect(() => resolveSourceTruthDir()).toThrow(/DAI_SOURCE_TRUTH_DIR.*missing truth\.json/);
    process.env[SOURCE_TRUTH_ENV] = join(dir, 'does-not-exist');
    expect(() => resolveSourceTruthDir()).toThrow(/DAI_SOURCE_TRUTH_DIR.*is not a directory/);
  });

  it('returns the directory when the layout is complete', () => {
    const dir = writeSourceLayout(syntheticTruth());
    process.env[SOURCE_TRUTH_ENV] = dir;
    expect(resolveSourceTruthDir()).toBe(dir);
    expect(loadTruth().dir).toBe(dir);
  });
});

describe('loadTruth', () => {
  it('rejects a truth.json without the source-truth shape', () => {
    expect(() => loadTruth(writeSourceLayout({}))).toThrow(/truth\.json does not have the source-truth shape: site\.name; pageCount; pages\[\]; navigationHierarchy\[\]; uiChromeStringsInHtml/);
    expect(() => loadTruth(writeSourceLayout({ ...syntheticTruth(), pageCount: 3 }))).toThrow(/pages\.length 2 differs from pageCount 3/);
  });

  it('exposes pages by path and the navigation hierarchy, and fails closed on unknown paths', () => {
    const truth = loadTruth(writeSourceLayout(syntheticTruth()));
    expect(truth.pageCount).toBe(2);
    expect(truth.site.name).toBe('Acme Docs');
    expect(truth.pageByPath('/guides/setup').title).toBe('Setup');
    expect(truth.pageByPath('/').placements[0].groupPath).toEqual(['Welcome']);
    expect(truth.navigationHierarchy.map((entry) => ('group' in entry ? entry.group : entry.page))).toEqual(['Welcome', 'Guides']);
    expect(() => truth.pageByPath('/guides/setup.md')).toThrow(/no page at \/guides\/setup\.md; known paths: \/, \/guides\/setup/);
  });

  it('keeps only literal theme strings from uiChromeStringsInHtml', () => {
    expect(loadTruth(writeSourceLayout(syntheticTruth())).chromeStrings()).toEqual([
      'Skip to main content', 'Expand image', 'Pagination', '⌘I', 'Responses are generated using AI and may contain mistakes.',
    ]);
  });
});
