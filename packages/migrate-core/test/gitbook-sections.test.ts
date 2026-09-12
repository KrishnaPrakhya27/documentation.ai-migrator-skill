/**
 * A site divided into sections (GitBook site sections) renders one sidebar per
 * section behind a section switcher. The migration must keep that structure: each
 * section becomes a `tab`, not another top-level sidebar group, because flattening
 * the sections changes what the source presents.
 */
import { describe, it, expect } from 'vitest';
import { extractDomSidebarNavigation, extractSectionTabs, sectionOfUrl, siteSectionNavigation, type DiscoveredNavigationNode } from '../src/scrape/discovery.js';
import { getProfile } from '../src/scrape/profiles.js';
import { buildNavigation, type SourceNavigationNode, type TreePage } from '../src/nav/tree.js';

const origin = 'https://site.test';
const seed = `${origin}/docs`;
const profile = getProfile('gitbook');

const sections = `<header><ul aria-label="Sections" data-gb-sections="true">
  <li id="sitesc_1"><a aria-label="Home" href="/docs"><svg><path d="M0 0"/></svg><span class="button-content truncate">Home</span></a></li>
  <li id="sitesc_2"><a aria-label="Documentation" href="/docs/documentation"><span class="button-content truncate">Documentation</span></a></li>
  <li id="sitesc_3"><a aria-label="API Reference" href="/docs/api-reference"><span class="button-content truncate">API Reference</span></a></li>
</ul></header>`;

/** The theme renders its assistant panel as an <aside> before the sidebar; it holds no navigation. */
const chatPanel = '<aside data-ai-chat="true"><div><button>Ask</button></div></aside>';

const page = (aside: string): string => `<html><body>${sections}${chatPanel}${aside}<main><h1>Page</h1></main></body></html>`;

const documentationAside = `<aside data-testid="table-of-contents">
  <a href="/docs"><img alt=""/><div>demo Docs</div></a>
  <ul>
  <li><a class="toclink" href="/docs/documentation/welcome"><span>Welcome</span></a></li>
  <li><button class="toc-group"><span class="min-w-0 flex-1">Getting Started</span><span class="toc-group-chevron"><svg><path d="M0 0"/></svg></span></button></li>
  <li><a class="toclink" href="/docs/documentation/quickstart"><span>Quickstart</span></a></li>
  <li><a class="toclink" href="/docs/documentation/first-project"><span>Your first project</span><span data-tag="" title="Beta"><span class="truncate">Beta</span></span></a></li>
</ul></aside>`;

const apiAside = `<aside data-testid="table-of-contents"><ul>
  <li><a class="toclink" href="/docs/api-reference/authentication"><span>Servers &amp; Authentication</span></a></li>
  <li><a class="toclink" href="/docs/api-reference/errors"><span>Error responses</span></a></li>
</ul></aside>`;

describe('site sections become tabs', () => {
  it('reads the section switcher for labels, order and urls', () => {
    expect(extractSectionTabs(page(documentationAside), seed, origin, profile)).toEqual([
      { label: 'Home', url: `${origin}/docs` },
      { label: 'Documentation', url: `${origin}/docs/documentation` },
      { label: 'API Reference', url: `${origin}/docs/api-reference` },
    ]);
  });

  it('reports no sections for a site that renders no switcher, so a single-sidebar site is untouched', () => {
    expect(extractSectionTabs(page(documentationAside).replace(/data-gb-sections="true"/, ''), seed, origin, profile)).toBeUndefined();
  });

  it('places a page in the section whose path is its longest matching prefix', () => {
    const found = extractSectionTabs(page(documentationAside), seed, origin, profile)!;
    expect(sectionOfUrl(`${origin}/docs/api-reference/errors`, found)?.label).toBe('API Reference');
    // the shortest section path is a prefix of every other; it must not swallow them
    expect(sectionOfUrl(`${origin}/docs`, found)?.label).toBe('Home');
  });

  it('keeps each section sidebar under its own tab and carries a section with no sidebar by its landing page', () => {
    const found = extractSectionTabs(page(documentationAside), seed, origin, profile)!;
    const sidebars = new Map<string, DiscoveredNavigationNode[]>([
      [`${origin}/docs/documentation`, extractDomSidebarNavigation(page(documentationAside), `${origin}/docs/documentation`, origin, profile)!],
      [`${origin}/docs/api-reference`, extractDomSidebarNavigation(page(apiAside), `${origin}/docs/api-reference`, origin, profile)!],
    ]);
    const navigation = siteSectionNavigation(found, sidebars)!;
    expect(navigation.map((node) => node.type === 'group' && [node.kind, node.label])).toEqual([
      ['tab', 'Home'], ['tab', 'Documentation'], ['tab', 'API Reference'],
    ]);
    // the section that was never crawled keeps its own page rather than inventing an empty tab
    expect(navigation[0]).toMatchObject({ children: [{ type: 'page', url: `${origin}/docs` }] });
    // the group heading the sidebar renders is preserved, with the links that follow it
    expect(navigation[1]).toMatchObject({
      children: [
        { type: 'page', url: `${origin}/docs/documentation/welcome`, title: 'Welcome' },
        { type: 'group', label: 'Getting Started', children: [
          { type: 'page', url: `${origin}/docs/documentation/quickstart`, title: 'Quickstart' },
          { type: 'page', url: `${origin}/docs/documentation/first-project`, title: 'Your first project' },
        ] },
      ],
    });
  });

  it('reads the sidebar past the assistant panel, and keeps the site logo and entry badges out of the labels', () => {
    const nodes = extractDomSidebarNavigation(page(documentationAside), `${origin}/docs/documentation`, origin, profile)!;
    // the logo link at the top of the sidebar points at the site root: chrome, not a navigation entry
    expect(JSON.stringify(nodes)).not.toContain('demo Docs');
    const group = nodes.find((node): node is Extract<typeof node, { type: 'group' }> => node.type === 'group')!;
    // "Beta" is a badge rendered inside the entry, never part of the label the source states
    expect(group.children).toContainEqual({ type: 'page', url: `${origin}/docs/documentation/first-project`, title: 'Your first project' });
  });

  it('writes documentation.json tabs, not another level of sidebar groups', () => {
    const urls = [
      [`${origin}/docs`, 'home'],
      [`${origin}/docs/documentation/welcome`, 'welcome'],
      [`${origin}/docs/documentation/quickstart`, 'quickstart'],
      [`${origin}/docs/api-reference/errors`, 'errors'],
    ] as const;
    const pages: TreePage[] = urls.map(([source, id], index) => ({
      id, title: id, source, group: [], order: index, newPath: id, migrate: true,
    }));
    const byUrl = new Map<string, string>(urls.map(([source, id]) => [source, id]));
    const found = extractSectionTabs(page(documentationAside), seed, origin, profile)!;
    const sidebars = new Map<string, DiscoveredNavigationNode[]>([
      [`${origin}/docs/documentation`, extractDomSidebarNavigation(page(documentationAside), `${origin}/docs/documentation`, origin, profile)!],
      [`${origin}/docs/api-reference`, extractDomSidebarNavigation(page(apiAside), `${origin}/docs/api-reference`, origin, profile)!],
    ]);
    const toSource = (nodes: DiscoveredNavigationNode[]): SourceNavigationNode[] => nodes.flatMap((node): SourceNavigationNode[] => {
      if (node.type === 'page') { const id = byUrl.get(node.url); return id ? [{ type: 'page', pageId: id, title: node.title }] : []; }
      const children = toSource(node.children);
      return children.length ? [{ ...node, children }] : [];
    });
    const { navigation } = buildNavigation(pages, { sourceNavigation: toSource(siteSectionNavigation(found, sidebars)!) });
    const tabs = navigation.tabs as Array<Record<string, unknown>>;
    expect(tabs.map((tab) => tab.tab)).toEqual(['Home', 'Documentation', 'API Reference']);
    expect(tabs[0]).toMatchObject({ pages: [{ title: 'home', path: 'home' }] });
    // the sidebar's own label is what the source shows, so it stands over the page title
    expect(tabs[1].pages).toEqual([
      { title: 'Welcome', path: 'welcome' },
      { group: 'Getting Started', pages: [{ title: 'Quickstart', path: 'quickstart' }] },
    ]);
  });
});
