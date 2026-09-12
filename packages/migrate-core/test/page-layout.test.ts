/**
 * A source varies its chrome per page: a landing page shows no sidebar while the pages of a
 * section do. Rendering every migrated page with a sidebar changes the structure the source
 * presents, so the layout the source showed is carried onto the page's navigation entry, which
 * is where the Documentation.AI renderer reads it from (`show-sidebar`, default true).
 */
import { describe, it, expect } from 'vitest';
import { extractDomSidebarNavigation, sidebarObserved, sidebarPageCount } from '../src/scrape/discovery.js';
import { getProfile } from '../src/scrape/profiles.js';
import { buildNavigation, type TreePage } from '../src/nav/tree.js';

const origin = 'https://docs.example.test';
const profile = getProfile('generic');
const page = (sidebar: string): string => `<html><body><div class="sidebar">${sidebar}</div><main><h1>Page</h1></main></body></html>`;
const count = (html: string, url: string): number => sidebarPageCount(extractDomSidebarNavigation(html, url, origin, profile));

describe('the sidebar a page rendered', () => {
  it('counts distinct pages, so a sidebar holding only this page is no navigation', () => {
    const landing = page('<ul><li><a href="/docs">Overview</a></li></ul>');
    const section = page('<ul><li><a href="/docs/install">Install</a></li><li><a href="/docs/config">Config</a></li></ul>');
    expect(count(landing, `${origin}/docs`)).toBe(1);
    expect(count(section, `${origin}/docs/install`)).toBe(2);
    // the same link repeated is still one page
    expect(count(page('<ul><li><a href="/docs">A</a></li><li><a href="/docs/">A again</a></li></ul>'), `${origin}/docs`)).toBe(1);
    expect(count(page('<ul></ul>'), `${origin}/docs`)).toBe(0);
  });

  it('treats a site that renders no sidebar anywhere as unobserved, never as sidebar-less', () => {
    // MadCap Flare serves an empty data-mc-toc skeleton and fills it in the browser: every page reads 0
    expect(sidebarObserved([{ sidebarPages: 0 }, { sidebarPages: 1 }, { sidebarPages: 0 }])).toBe(false);
    expect(sidebarObserved([{ sidebarPages: 0 }, { sidebarPages: 9 }])).toBe(true);
    expect(sidebarObserved([{}, {}])).toBe(false);
  });
});

describe('writing the layout onto the navigation entry', () => {
  const pages = (sidebars: Array<TreePage['sourceSidebar']>): TreePage[] => sidebars.map((sourceSidebar, index) => ({
    id: `p${index}`, title: `Page ${index}`, source: `${origin}/p${index}`, group: [], order: index,
    newPath: `p${index}`, migrate: true, ...(sourceSidebar ? { sourceSidebar } : {}),
  }));

  it('writes show-sidebar false only for a page the source rendered without one', () => {
    const { navigation } = buildNavigation(pages(['absent', 'rendered']));
    expect(navigation.pages).toEqual([
      { 'show-sidebar': false, title: 'Page 0', path: 'p0' },
      { title: 'Page 1', path: 'p1' },
    ]);
  });

  it('writes nothing when the source layout was never observed, leaving the platform default', () => {
    const { navigation } = buildNavigation(pages([undefined, undefined]));
    expect(JSON.stringify(navigation)).not.toContain('show-sidebar');
  });

  it('carries the layout through a source navigation tree, not just a flat page list', () => {
    const tree = pages(['absent', 'rendered']);
    const { navigation } = buildNavigation(tree, {
      sourceNavigation: [
        { type: 'group', kind: 'tab', label: 'Home', children: [{ type: 'page', pageId: 'p0' }] },
        { type: 'group', kind: 'tab', label: 'Docs', children: [{ type: 'page', pageId: 'p1' }] },
      ],
    });
    const tabs = navigation.tabs as Array<Record<string, unknown>>;
    expect(tabs[0].pages).toEqual([{ 'show-sidebar': false, title: 'Page 0', path: 'p0' }]);
    expect(tabs[1].pages).toEqual([{ title: 'Page 1', path: 'p1' }]);
  });
});
