import { describe, it, expect } from 'vitest';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { buildNavigation, type TreePage, type SourceNavigationNode } from '../src/nav/tree.js';

// gitbook.com/docs, as published
const read = (body: string) => markdownToIr(`---\ntitle: T\n---\n\n${body}\n`, { platform: 'gitbook', file: 'p.md', pageId: 'p' });
const cards = (doc: ReturnType<typeof read>) => (doc.children.find((b: any) => b.type === 'component' && b.name === 'cards') as any);
const CARDS = '<table data-view="cards"><thead><tr><th></th><th></th><th></th></tr></thead><tbody>'
  + '<tr><td><h4><i class="fa-hand-pointer">:hand-pointer:</i></h4></td><td><h4>In the editor</h4></td><td>Write visually.</td></tr>'
  + '<tr><td><h4><i class="fa-claude">:claude:</i> <i class="fa-chatgpt">:chatgpt:</i> <i class="fa-cursor">:cursor:</i></h4></td><td><h4>From your agent</h4></td><td>Drive GitBook.</td></tr>'
  + '<tr><td><h4><i class="fa-code">:code:</i></h4></td><td><h4>With code</h4></td><td>Sync from Git.</td></tr>'
  + '</tbody></table>';

describe('GitBook landing page layout', () => {
  it('lays cards out three to a row, as GitBook does', () => {
    expect(cards(read(CARDS)).props.cols).toBe(3);
    expect(cards(read(CARDS.replace('data-view="cards"', 'data-view="cards" data-card-size="large"'))).props.cols).toBe(2);
  });

  it('reads a row of icons as the card icon, never its title, and names icons as Lucide does', () => {
    const [editor, agent, code] = cards(read(CARDS)).children.map((c: any) => c.props);
    expect(editor).toMatchObject({ title: 'In the editor', icon: 'pointer' });
    expect(code).toMatchObject({ title: 'With code', icon: 'code' });
    // three brand logos: the card is titled by its heading and carries no icon Lucide cannot draw
    expect(agent.title).toBe('From your agent');
    expect(agent.icon).toBeUndefined();
  });

  it('keeps the gap between buttons written side by side', () => {
    const doc = read('<a href="/docs/getting-started/quickstart.md" class="button primary">Quickstart</a><a href="/docs/docs-as-code/gitbook-mcp.md" class="button secondary" data-icon="sparkles">GitBook MCP</a>');
    const text = JSON.stringify(doc.children);
    expect(text).toMatch(/"Quickstart"[\s\S]*"value":" "[\s\S]*"GitBook MCP"/);
    // two ordinary links written together are left exactly as the author wrote them
    expect(JSON.stringify(read('<a href="/a.md">A</a><a href="/b.md">B</a>').children)).not.toContain('"value":" "');
  });
});

describe('navigation per language', () => {
  const page = (id: string, locale: string, path: string): TreePage => ({ id, title: id, source: `https://x/${path}`, group: [], order: 0, migrate: true, locale, newPath: path });
  const pages = [page('en1', 'en', 'en/docs/a'), page('en2', 'en', 'en/docs/dev/quickstart'), page('fr1', 'fr', 'fr/docs/a'), page('fr2', 'fr', 'fr/docs/b')];
  const nav: SourceNavigationNode[] = [
    { type: 'group', kind: 'tab', label: 'Documentation', children: [{ type: 'page', pageId: 'en1', title: 'A' }] },
    { type: 'group', kind: 'tab', label: 'Developers', children: [{ type: 'page', pageId: 'en2', title: 'Quickstart' }] },
    // the French sidebar links one untranslated English page
    { type: 'group', kind: 'tab', label: 'Documentation', children: [{ type: 'page', pageId: 'fr1', title: 'A' }, { type: 'page', pageId: 'fr2', title: 'B' }, { type: 'page', pageId: 'en2', title: 'Quickstart' }] },
  ] as any;

  it('gives each language only its own tabs', () => {
    const out = buildNavigation(pages, { sourceNavigation: nav, defaultLocale: 'en' }).navigation as any;
    const tabs = Object.fromEntries(out.languages.map((l: any) => [l.language, l.tabs.map((t: any) => t.tab)]));
    expect(tabs).toEqual({ en: ['Documentation', 'Developers'], fr: ['Documentation'] });
  });
});

import { extractSiteSectionsData, siteSectionNavigation } from '../src/scrape/discovery.js';

describe('GitBook section groups (the "Resources" menu)', () => {
  // as gitbook.com/docs embeds it, inside an escaped script payload
  const payload = JSON.stringify([
    { id: 'sitesc_SsMCE', title: 'Documentation', description: 'docs', icon: 'book-open', object: 'site-section', url: '/docs' },
    { id: 'sitesc_ybTYt', title: 'Developers', description: 'api', icon: 'code', object: 'site-section', url: '/docs/developers' },
    { id: 'sitescg_ya0Yt', title: 'Resources', icon: 'circle-info', object: 'site-section-group', children: [
      { id: 'sitesc_go8RV', title: 'Changelog', description: 'updates', icon: 'bars-staggered', object: 'site-section', url: '/docs/changelog' },
      { id: 'sitesc_VMAfS', title: 'Policies', description: 'policies', icon: 'file-contract', object: 'site-section', url: '/docs/policies' },
      { id: 'sitesc_hLE5x', title: 'Guides', description: 'guides', icon: 'book', object: 'site-section', url: '/docs/guides' },
    ] },
  ]);
  const html = `<script>self.__next_f.push([1,"x:{\\"sections\\":${payload.replace(/"/g, '\\"')},\\"current\\":{}}"])</script>`;

  it('reads every section and the group it sits under from the embedded site data', () => {
    expect(extractSiteSectionsData(html, 'https://gitbook.com/docs', 'https://gitbook.com')).toEqual([
      { label: 'Documentation', url: 'https://gitbook.com/docs' },
      { label: 'Developers', url: 'https://gitbook.com/docs/developers' },
      { label: 'Changelog', url: 'https://gitbook.com/docs/changelog', group: 'Resources' },
      { label: 'Policies', url: 'https://gitbook.com/docs/policies', group: 'Resources' },
      { label: 'Guides', url: 'https://gitbook.com/docs/guides', group: 'Resources' },
    ]);
  });

  it('writes a section group as one tab whose sections are dropdowns', () => {
    const sections = extractSiteSectionsData(html, 'https://gitbook.com/docs', 'https://gitbook.com')!;
    const nav = siteSectionNavigation(sections, new Map()) as any[];
    expect(nav.map((n) => [n.kind, n.label])).toEqual([['tab', 'Documentation'], ['tab', 'Developers'], ['tab', 'Resources']]);
    expect(nav[2].children.map((c: any) => [c.kind, c.label])).toEqual([['dropdown', 'Changelog'], ['dropdown', 'Policies'], ['dropdown', 'Guides']]);
  });
});
