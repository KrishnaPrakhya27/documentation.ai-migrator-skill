/**
 * Two things a Mintlify site states that the migrated sidebar used to get wrong. A tab marked
 * `hidden` is published but not shown — mintlify.com hides a whole Help center this way — and the
 * sidebar carried it as a tab the reader never saw. A tab built from a `menu` of `item`s, which is
 * what the platform calls dropdowns, had no recognised label and vanished, taking the Learn tab and
 * its guides with it.
 */
import { describe, it, expect } from 'vitest';
import { extractMintlifyNavigation, mergeNavigation, pruneNavigationStubs } from '../src/scrape/discovery.js';
import { buildNavigation, placedPageIds, sourceNavigationFromDiscovered } from '../src/nav/tree.js';

const html = (nav: unknown): string => `<html><script>self.__next_f.push([1,${JSON.stringify(`0:${JSON.stringify({ scopedNav: nav })}`)}])</script></html>`;

const SITE = {
  tabs: [
    { tab: 'Documentation', pages: [{ title: 'Home', href: '/' }, { title: 'Quickstart', href: '/quickstart' }] },
    { tab: 'Help center', hidden: true, pages: [{ title: 'Fix the build', href: '/help-center/fix-the-build' }] },
    { tab: 'Learn', menu: [
      { item: 'Learn', description: 'Self-paced lessons.', href: 'https://learn.example.com/' },
      { item: 'Guides', description: 'How-to guides.', groups: [{ group: 'AI', pages: [{ title: 'Build an assistant', href: '/guides/assistant' }] }] },
    ] },
  ],
};

describe('a Mintlify navigation with a hidden tab and a menu', () => {
  const found = extractMintlifyNavigation(html(SITE), 'https://docs.example/')!;

  it('keeps a hidden tab where and as the site states it, marked hidden, so it is out of the sidebar unless an operator places it', () => {
    expect(found.navigation.map((node) => (node.type === 'group' ? `${node.label}${node.hidden ? ' (hidden)' : ''}` : node.url))).toEqual(['Documentation', 'Help center (hidden)', 'Learn']);
    const byUrl = (url: string): string | undefined => ({ 'https://docs.example/': 'home', 'https://docs.example/quickstart': 'quick', 'https://docs.example/help-center/fix-the-build': 'fix', 'https://docs.example/guides/assistant': 'assistant' } as Record<string, string>)[url];
    const navigation = sourceNavigationFromDiscovered(found.navigation, byUrl);
    // a hidden page is published and placed nowhere a reader sees
    expect([...placedPageIds(navigation)].sort()).toEqual(['assistant', 'home', 'quick']);
    expect([...placedPageIds(navigation, true)].sort()).toEqual(['assistant', 'fix', 'home', 'quick']);
    const pages = [['home', 'index'], ['quick', 'quickstart'], ['fix', 'help-center/fix-the-build'], ['assistant', 'guides/assistant']].map(([id, newPath], order) => ({ id, title: id, source: `https://docs.example/${newPath}`, group: [], order, migrate: true, newPath }));
    const tabsOf = (placeUnlisted: boolean): string[] => ((buildNavigation(pages, { sourceNavigation: navigation, placeUnlisted }).navigation as { tabs: Array<{ tab: string }> }).tabs).map((tab) => tab.tab);
    expect(tabsOf(false)).toEqual(['Documentation', 'Learn']);
    // placed by decision, it is the source's own tab with the source's own label and position
    expect(tabsOf(true)).toEqual(['Documentation', 'Help center', 'Learn']);
  });

  it('still discovers the hidden pages, so they migrate and are reported as unlisted', () => {
    expect(found.pages.map((page) => page.url)).toContain('https://docs.example/help-center/fix-the-build');
  });

  it('reads a menu as the dropdowns the platform renders it with', () => {
    expect(found.navigation[2]).toEqual({
      type: 'group', kind: 'tab', label: 'Learn', children: [
        { type: 'group', kind: 'dropdown', label: 'Learn', href: 'https://learn.example.com/', description: 'Self-paced lessons.', children: [] },
        { type: 'group', kind: 'dropdown', label: 'Guides', description: 'How-to guides.', children: [
          { type: 'group', label: 'AI', children: [{ type: 'page', url: 'https://docs.example/guides/assistant', title: 'Build an assistant' }] },
        ] },
      ],
    });
  });
});

describe('the order a Mintlify site lists its tabs in', () => {
  // Each page states its own tab in full and every sibling as a one-entry switcher stub.
  const stub = (tab: string, href: string) => ({ tab, pages: [{ title: tab, href }] });
  const fromDocs = { tabs: [{ tab: 'Documentation', pages: [{ title: 'Home', href: '/' }] }, stub('API reference', '/api/intro'), stub('Changelog', '/changelog'), { tab: 'Learn', menu: [{ item: 'Guides', pages: [{ title: 'Guide', href: '/guides/a' }] }] }] };
  const fromApi = { tabs: [stub('Documentation', '/'), { tab: 'API reference', pages: [{ title: 'Intro', href: '/api/intro' }] }, stub('Changelog', '/changelog'), { tab: 'Learn', menu: [{ item: 'Guides', pages: [{ title: 'Guide', href: '/guides/a' }] }] }] };
  const read = (nav: unknown) => extractMintlifyNavigation(html(nav), 'https://docs.example/', { keepStubs: true })!.navigation;

  it('survives the union of per-page readings, whichever page the crawl reaches first', () => {
    const labels = (nodes: ReturnType<typeof read>) => nodes.map((node) => (node.type === 'group' ? node.label : node.url));
    // Documentation's page first: API reference is only a stub there, and used to be appended after Learn
    expect(labels(pruneNavigationStubs(mergeNavigation(read(fromDocs), read(fromApi))))).toEqual(['Documentation', 'API reference', 'Learn']);
    expect(labels(pruneNavigationStubs(mergeNavigation(read(fromApi), read(fromDocs))))).toEqual(['Documentation', 'API reference', 'Learn']);
  });

  it('leaves no placeholder behind: a tab no crawled page states is not in the navigation, and one reading alone shows none', () => {
    expect(JSON.stringify(pruneNavigationStubs(mergeNavigation(read(fromDocs), read(fromApi))))).not.toContain('stub');
    expect(extractMintlifyNavigation(html(fromDocs), 'https://docs.example/')!.navigation.map((node) => (node.type === 'group' ? node.label : node.url))).toEqual(['Documentation', 'Learn']);
  });
});

