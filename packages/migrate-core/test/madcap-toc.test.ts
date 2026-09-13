/**
 * A published Flare site builds its sidebar in the browser, so crawling one yields no navigation at
 * all — the 448-page capture this was written against produced none. The data those scripts read is
 * static, and these tests hold it in the shape three live builds actually serve it, down to the
 * single-quoted `define({...})` spelling and the per-project table-of-contents filename.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverLiveSite, navigationFromFrozenPages } from '../src/scrape/discovery.js';
import { Fetcher, type FetchImpl } from '../src/scrape/fetcher.js';
import { getProfile } from '../src/scrape/profiles.js';
import { ensureWorkspace } from '../src/session/workspace.js';
import { liveSourceManifest } from '../src/evidence/capture.js';
import { fetchFlareData, flareNavigationFromData, helpSystemRoot, parseDefine, tocPathFromHelpSystem, type FlareFetch } from '../src/scrape/madcap-toc.js';

/** The bytes a Flare build serves, as captured. */
const HELP_SYSTEM = `<?xml version="1.0" encoding="utf-8"?>\n<WebHelpSystem xmlns:MadCap="http://www.madcapsoftware.com/Schemas/MadCap.xsd" Toc="Data/Tocs/CurrentNav.js" Skin="Data/Skin.xml" />`;

const TOC = `define({numchunks:1,prefix:'release_notes_toc_Chunk',chunkstart:['/ReleaseNotes/release-2022-1.htm'],tree:{n:[{i:0,c:0,n:[{i:1,c:0},{i:2,c:0}]},{i:3,c:0}]}});`;

const CHUNK = `define({'/ReleaseNotes/release-2022-1.htm':{i:[0],t:['Release Notes'],b:['']},'/ReleaseNotes/2022-1.htm':{i:[1],t:['2022.1'],b:['']},'/ReleaseNotes/2021-4.htm':{i:[2],t:['2021.4'],b:['']},'/GettingStarted.htm':{i:[3],t:['Getting Started'],b:['']}});`;

const PAGE = `<?xml version="1.0" encoding="utf-8"?>\n<html data-mc-path-to-help-system="../" data-mc-help-system-file-name="Default.htm"><body><h1>2022.1</h1></body></html>`;

const HOST = 'https://learn.example.com';

const serve = (files: Record<string, string>): FlareFetch & { seen: string[] } => {
  const seen: string[] = [];
  const fetch = async (url: string): Promise<{ status: number; body: string }> => {
    seen.push(url);
    const body = files[url.replace(HOST, '')];
    return body === undefined ? { status: 404, body: '' } : { status: 200, body };
  };
  return Object.assign(fetch, { seen });
};

/** The two halves as discovery uses them: walk the chain, then assemble from what it read. */
const readFlareNavigation = async (pageUrl: string, html: string, fetch: FlareFetch) => {
  const data = await fetchFlareData(pageUrl, html, fetch);
  return data && flareNavigationFromData(pageUrl, html, data);
};

const SITE = {
  '/Data/HelpSystem.xml': HELP_SYSTEM,
  '/Data/Tocs/CurrentNav.js': TOC,
  '/Data/Tocs/release_notes_toc_Chunk0.js': CHUNK,
};

describe('the help system a page belongs to', () => {
  it('resolves the attribute against the page\'s own directory, not the host', () => {
    // One host can serve several independent help systems; a per-host guess reads the wrong sidebar.
    expect(helpSystemRoot(PAGE, `${HOST}/developer/ReleaseNotes/2022-1.htm`)).toBe(`${HOST}/developer/`);
    expect(helpSystemRoot(PAGE, `${HOST}/ReleaseNotes/2022-1.htm`)).toBe(`${HOST}/`);
  });

  it('is absent for a page that is not Flare output', () => {
    expect(helpSystemRoot('<html><body>Hello</body></html>', `${HOST}/x.htm`)).toBeUndefined();
  });

  it('reads the table of contents the project names rather than assuming one', () => {
    // Three surveyed builds used three different names; none was a documented default.
    expect(tocPathFromHelpSystem(HELP_SYSTEM)).toBe('Data/Tocs/CurrentNav.js');
    expect(tocPathFromHelpSystem(HELP_SYSTEM.replace('Data/Tocs/CurrentNav.js', 'Data/Tocs/Flare_Desktop_Online.js'))).toBe('Data/Tocs/Flare_Desktop_Online.js');
  });
});

describe('the define() data files', () => {
  it('reads single-quoted keys and values without evaluating them', () => {
    expect(parseDefine(TOC)).toEqual({
      numchunks: 1,
      prefix: 'release_notes_toc_Chunk',
      chunkstart: ['/ReleaseNotes/release-2022-1.htm'],
      tree: { n: [{ i: 0, c: 0, n: [{ i: 1, c: 0 }, { i: 2, c: 0 }] }, { i: 3, c: 0 }] },
    });
  });

  it('keeps an apostrophe inside a title', () => {
    const parsed = parseDefine(`define({'/a.htm':{i:[0],t:['What\\'s New'],b:['']}});`) as Record<string, { t: string[] }>;
    expect(parsed['/a.htm'].t[0]).toBe("What's New");
  });

  it('refuses anything that is not a define() data file', () => {
    expect(() => parseDefine('window.location = "x"')).toThrow(/not a define/);
  });
});

describe('the published sidebar', () => {
  it('is the real tree, with titles and links, from a single topic page', async () => {
    const navigation = await readFlareNavigation(`${HOST}/ReleaseNotes/2022-1.htm`, PAGE, serve(SITE));
    expect(navigation?.toc).toBe(`${HOST}/Data/Tocs/CurrentNav.js`);
    expect(navigation?.unresolved).toBe(0);
    expect(navigation?.nodes).toEqual([
      {
        type: 'group',
        label: 'Release Notes',
        children: [
          { type: 'page', url: `${HOST}/ReleaseNotes/release-2022-1.htm`, title: 'Release Notes' },
          { type: 'page', url: `${HOST}/ReleaseNotes/2022-1.htm`, title: '2022.1' },
          { type: 'page', url: `${HOST}/ReleaseNotes/2021-4.htm`, title: '2021.4' },
        ],
      },
      { type: 'page', url: `${HOST}/GettingStarted.htm`, title: 'Getting Started' },
    ]);
  });

  it('reads every chunk, because the tree routinely references the last one', async () => {
    const files = {
      '/Data/HelpSystem.xml': HELP_SYSTEM,
      '/Data/Tocs/CurrentNav.js': `define({numchunks:2,prefix:'toc_Chunk',tree:{n:[{i:0,c:0},{i:9,c:1}]}});`,
      '/Data/Tocs/toc_Chunk0.js': `define({'/a.htm':{i:[0],t:['A'],b:['']}});`,
      '/Data/Tocs/toc_Chunk1.js': `define({'/z.htm':{i:[9],t:['Z'],b:['']}});`,
    };
    const fetch = serve(files);
    const navigation = await readFlareNavigation(`${HOST}/a.htm`, PAGE, fetch);
    expect(navigation?.nodes).toEqual([
      { type: 'page', url: `${HOST}/a.htm`, title: 'A' },
      { type: 'page', url: `${HOST}/z.htm`, title: 'Z' },
    ]);
    expect(fetch.seen).toContain(`${HOST}/Data/Tocs/toc_Chunk1.js`);
  });

  it('refuses to return a half-read sidebar when a chunk is missing', async () => {
    const files = { ...SITE, '/Data/Tocs/CurrentNav.js': TOC.replace('numchunks:1', 'numchunks:2') };
    // Silently dropping the branch would hand the customer a shortened sidebar that looks complete.
    await expect(readFlareNavigation(`${HOST}/a.htm`, PAGE, serve(files))).rejects.toThrow(/chunk 1 of 2 is missing/);
  });

  it('reads a second help system on the same host independently', async () => {
    const files = {
      ...SITE,
      '/developer/Data/HelpSystem.xml': HELP_SYSTEM.replace('Data/Tocs/CurrentNav.js', 'Data/Tocs/DevNav.js'),
      '/developer/Data/Tocs/DevNav.js': `define({numchunks:1,prefix:'dev_Chunk',tree:{n:[{i:0,c:0}]}});`,
      '/developer/Data/Tocs/dev_Chunk0.js': `define({'/API/auth.htm':{i:[0],t:['Authentication'],b:['']}});`,
    };
    const navigation = await readFlareNavigation(`${HOST}/developer/API/auth.htm`, PAGE, serve(files));
    expect(navigation?.nodes).toEqual([{ type: 'page', url: `${HOST}/developer/API/auth.htm`, title: 'Authentication' }]);
  });

  it('keeps a heading that has no page as a group', async () => {
    const files = {
      '/Data/HelpSystem.xml': HELP_SYSTEM,
      '/Data/Tocs/CurrentNav.js': `define({numchunks:1,prefix:'t_Chunk',tree:{n:[{i:0,c:0,n:[{i:1,c:0}]}]}});`,
      '/Data/Tocs/t_Chunk0.js': `define({'___':{i:[0],t:['Guides'],b:['']},'/g/install.htm':{i:[1],t:['Install'],b:['']}});`,
    };
    const navigation = await readFlareNavigation(`${HOST}/g/install.htm`, PAGE, serve(files));
    expect(navigation?.nodes).toEqual([
      { type: 'group', label: 'Guides', children: [{ type: 'page', url: `${HOST}/g/install.htm`, title: 'Install' }] },
    ]);
  });

  it('keeps the bookmark an entry points at, so a deep link lands on its section', async () => {
    const files = {
      '/Data/HelpSystem.xml': HELP_SYSTEM,
      '/Data/Tocs/CurrentNav.js': `define({numchunks:1,prefix:'b_Chunk',tree:{n:[{i:0,c:0}]}});`,
      '/Data/Tocs/b_Chunk0.js': `define({'/guides/install.htm':{i:[0],t:['Configure the agent'],b:['configure-the-agent']}});`,
    };
    const navigation = await readFlareNavigation(`${HOST}/guides/install.htm`, PAGE, serve(files));
    expect(navigation?.nodes).toEqual([{ type: 'page', url: `${HOST}/guides/install.htm#configure-the-agent`, title: 'Configure the agent' }]);
  });

  it('counts a node no chunk supplied instead of passing off a shorter tree as whole', async () => {
    const files = { ...SITE, '/Data/Tocs/CurrentNav.js': TOC.replace('{i:3,c:0}', '{i:77,c:0}') };
    const navigation = await readFlareNavigation(`${HOST}/a.htm`, PAGE, serve(files));
    expect(navigation?.unresolved).toBe(1);
    expect(navigation?.nodes).toHaveLength(1);
  });

  it('returns nothing for a site that is not Flare, without fetching', async () => {
    const fetch = serve({});
    expect(await readFlareNavigation(`${HOST}/x`, '<html><body>Hi</body></html>', fetch)).toBeUndefined();
    expect(fetch.seen).toEqual([]);
  });

  it('returns nothing when the help system data is not published', async () => {
    expect(await readFlareNavigation(`${HOST}/a.htm`, PAGE, serve({}))).toBeUndefined();
  });
});

describe('a live Flare site, crawled', () => {
  const page = (body: string, depth = 0): string =>
    `<html data-mc-path-to-help-system="${'../'.repeat(depth) || './'}"><body>${body}</body></html>`;

  const SITE_FILES: Record<string, string> = {
    '/Default.htm': page('<h1>Home</h1><a href="/ReleaseNotes/2022-1.htm">Notes</a>'),
    '/ReleaseNotes/2022-1.htm': page('<h1>2022.1</h1>', 1),
    '/ReleaseNotes/release-2022-1.htm': page('<h1>Release Notes</h1>', 1),
    '/ReleaseNotes/2021-4.htm': page('<h1>2021.4</h1>', 1),
    '/GettingStarted.htm': page('<h1>Getting Started</h1>'),
    ...SITE,
  };

  const site = (async (input: any) => {
    const { pathname } = new URL(typeof input === 'string' ? input : input.toString());
    const body = SITE_FILES[pathname];
    if (body === undefined) return new Response('nope', { status: 404 });
    const type = pathname.endsWith('.xml') ? 'application/xml' : pathname.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8';
    return new Response(body, { status: 200, headers: { 'content-type': type } });
  }) as unknown as FetchImpl;

  const crawl = async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dai-flare-crawl-'));
    ensureWorkspace(workspace);
    // The generic profile on purpose: Flare has no profile of its own, and the page's own
    // declaration is what identifies it.
    return discoverLiveSite({ seedUrl: 'http://8.8.8.8/Default.htm', fetcher: new Fetcher({ workspace, rps: 1000, fetchImpl: site }), profile: getProfile('generic') });
  };

  it('recovers the sidebar a crawl of the HTML cannot see', async () => {
    const found = await crawl();
    expect(found.navigationSource).toBe('platform-metadata');
    expect(found.navigation).toEqual([
      {
        type: 'group',
        label: 'Release Notes',
        children: [
          { type: 'page', url: 'http://8.8.8.8/ReleaseNotes/release-2022-1.htm', title: 'Release Notes' },
          { type: 'page', url: 'http://8.8.8.8/ReleaseNotes/2022-1.htm', title: '2022.1' },
          { type: 'page', url: 'http://8.8.8.8/ReleaseNotes/2021-4.htm', title: '2021.4' },
        ],
      },
      { type: 'page', url: 'http://8.8.8.8/GettingStarted.htm', title: 'Getting Started' },
    ]);
  });

  it('carries the groups and exact sidebar labels onto the pages it places', async () => {
    const byUrl = Object.fromEntries((await crawl()).pages.map((found) => [found.url, found]));
    expect(byUrl['http://8.8.8.8/ReleaseNotes/2021-4.htm'].groupHint).toEqual(['Release Notes']);
    expect(byUrl['http://8.8.8.8/ReleaseNotes/2021-4.htm'].sidebarTitle).toBe('2021.4');
    expect(byUrl['http://8.8.8.8/ReleaseNotes/2021-4.htm'].orderSource).toBe('sidebar');
    // A page the sidebar never linked from the HTML is still discovered through the tree.
    expect(byUrl['http://8.8.8.8/GettingStarted.htm'].reasons).toContain('platform-navigation');
  });

  it('freezes the data files, so the same tree is re-derived with no network', async () => {
    const found = await crawl();
    expect(found.navigationData?.map((file) => file.url)).toEqual([
      'http://8.8.8.8/Data/HelpSystem.xml',
      'http://8.8.8.8/Data/Tocs/CurrentNav.js',
      'http://8.8.8.8/Data/Tocs/release_notes_toc_Chunk0.js',
    ]);
    const frozen = found.pages.map((found) => ({ url: found.url, html: SITE_FILES[new URL(found.url).pathname] }));
    const derived = navigationFromFrozenPages(frozen, 'madcap', 'http://8.8.8.8/Default.htm', 'http://8.8.8.8', getProfile('generic'), new Map(found.navigationData!.map((file) => [file.url, file.body])));
    expect(derived?.source).toBe('platform-metadata');
    expect(derived?.nodes).toEqual(found.navigation);
  });

  it('reports a second help system on the same host instead of merging two sidebars', async () => {
    // Real shape: the site this was written against serves 438 pages under one help system and 13
    // under another. Concatenating them would state a structure the source does not have.
    const files: Record<string, string> = {
      ...SITE_FILES,
      '/Default.htm': page('<h1>Home</h1><a href="/developer/API/auth.htm">Developer</a>'),
      '/developer/API/auth.htm': page('<h1>Authentication</h1>', 1),
      '/developer/Data/HelpSystem.xml': HELP_SYSTEM.replace('Data/Tocs/CurrentNav.js', 'Data/Tocs/DevNav.js'),
      '/developer/Data/Tocs/DevNav.js': `define({numchunks:1,prefix:'dev_Chunk',tree:{n:[{i:0,c:0}]}});`,
      '/developer/Data/Tocs/dev_Chunk0.js': `define({'/API/auth.htm':{i:[0],t:['Authentication'],b:['']}});`,
    };
    const twoSystems = (async (input: any) => {
      const { pathname } = new URL(typeof input === 'string' ? input : input.toString());
      const body = files[pathname];
      if (body === undefined) return new Response('nope', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-type': pathname.endsWith('.xml') ? 'application/xml' : pathname.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' } });
    }) as unknown as FetchImpl;
    const workspace = mkdtempSync(join(tmpdir(), 'dai-flare-two-'));
    ensureWorkspace(workspace);
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/Default.htm', fetcher: new Fetcher({ workspace, rps: 1000, fetchImpl: twoSystems }), profile: getProfile('madcap') });

    // The seed's help system is the site's navigation, and the other is named, not folded in.
    expect(found.navigation?.some((node) => node.type === 'page' && node.url.includes('/developer/'))).toBe(false);
    expect(found.failures.map((failure) => failure.error)).toContainEqual(expect.stringContaining('a second MadCap help system is published here'));
    expect(found.structuralIssues).toContainEqual(expect.stringContaining('a second MadCap help system is published here'));
    const manifest = liveSourceManifest({ location: 'http://8.8.8.8/Default.htm', platform: 'madcap', contentContractVersion: 'test', capturedAt: '2026-09-13T00:00:00.000Z' }, found);
    expect(manifest.issues).toContainEqual(expect.stringContaining('a second MadCap help system is published here'));
    // Its pages are still discovered: leaving them out of the crawl would hide them entirely.
    expect(found.pages.map((crawled) => crawled.url)).toContain('http://8.8.8.8/developer/API/auth.htm');
  });

  it('leaves a site that is not Flare untouched', async () => {
    const plain = (async () => new Response('<html><body><h1>Hi</h1></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as FetchImpl;
    const workspace = mkdtempSync(join(tmpdir(), 'dai-plain-'));
    ensureWorkspace(workspace);
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/', fetcher: new Fetcher({ workspace, rps: 1000, fetchImpl: plain }), profile: getProfile('generic') });
    expect(found.navigationData).toBeUndefined();
  });
});
