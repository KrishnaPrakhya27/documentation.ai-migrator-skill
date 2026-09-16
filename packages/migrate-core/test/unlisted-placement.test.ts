/**
 * Pages a site publishes but never names in its sidebar. The renderer serves only routes the
 * navigation names, so an operator may place them - and where they go has to be the source's own
 * structure, not a shape invented here. A site that states languages above its content is the case
 * that proves it: a group pushed in beside languages is not representable at all.
 */
import { describe, it, expect } from 'vitest';
import { buildNavigation, type SourceNavigationNode, type TreePage } from '../src/nav/tree.js';

const page = (id: string, route: string, group: string[], title = id): TreePage =>
  ({ id, title, group, order: 0, migrate: true, newPath: route, source: `https://site.test/${route}` } as unknown as TreePage);

/** en and fr, each a language holding one tab of two groups, exactly as a Mintlify site states it. */
const listed: TreePage[] = [
  page('a', 'docs/deploy/vercel', ['docs', 'deploy']),
  page('b', 'docs/deploy/gitlab', ['docs', 'deploy']),
  page('c', 'docs/guides/start', ['docs', 'guides']),
  page('d', 'docs/fr/deploy/vercel', ['docs', 'fr', 'deploy']),
  page('e', 'docs/fr/guides/start', ['docs', 'fr', 'guides']),
];
const sourceNavigation: SourceNavigationNode[] = [
  { type: 'group', kind: 'language', label: 'en', children: [
    { type: 'group', kind: 'tab', label: 'Documentation', children: [
      { type: 'group', label: 'Deploy', children: [{ type: 'page', pageId: 'a' }, { type: 'page', pageId: 'b' }] },
      { type: 'group', label: 'Guides', children: [{ type: 'page', pageId: 'c' }] },
    ] },
  ] },
  { type: 'group', kind: 'language', label: 'fr', children: [
    { type: 'group', kind: 'tab', label: 'Documentation', children: [
      { type: 'group', label: 'Déployer', children: [{ type: 'page', pageId: 'd' }] },
      { type: 'group', label: 'Guides', children: [{ type: 'page', pageId: 'e' }] },
    ] },
  ] },
] as unknown as SourceNavigationNode[];

const build = (extra: TreePage[]) => buildNavigation([...listed, ...extra], { sourceNavigation, placeUnlisted: true });
const routesUnder = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) { for (const item of node) routesUnder(item, out); return out; }
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  if (typeof record.path === 'string') out.push(record.path);
  for (const value of Object.values(record)) if (Array.isArray(value)) routesUnder(value, out);
  return out;
};
const languages = (navigation: Record<string, unknown>) => (navigation as { languages: Array<Record<string, unknown>> }).languages;
const tabsOf = (navigation: Record<string, unknown>, language: string) =>
  (languages(navigation).find((entry) => entry.language === language)!.tabs as Array<Record<string, unknown>>);

describe('placing pages the sidebar never named', () => {
  it('puts a page in the container the source already publishes its folder in', () => {
    const { navigation } = build([page('x', 'docs/deploy/render', ['docs', 'deploy'])]);
    const deploy = (tabsOf(navigation, 'en')[0].groups as Array<Record<string, unknown>>).find((group) => group.group === 'Deploy')!;
    expect(routesUnder(deploy)).toContain('docs/deploy/render');
    expect(tabsOf(navigation, 'en')).toHaveLength(1);
  });

  it('keeps a page in its own language rather than beside the languages, which cannot be represented', () => {
    const { navigation } = build([page('x', 'docs/fr/deploy/render', ['docs', 'fr', 'deploy'])]);
    expect(routesUnder(languages(navigation).find((entry) => entry.language === 'fr'))).toContain('docs/fr/deploy/render');
    expect(routesUnder(languages(navigation).find((entry) => entry.language === 'en'))).not.toContain('docs/fr/deploy/render');
  });

  it('opens a section the sidebar has no container for as a container of its own, at the level that holds one', () => {
    const { navigation } = build([
      page('x', 'docs/help-center/oauth', ['docs', 'help center']),
      page('y', 'docs/fr/help-center/oauth', ['docs', 'fr', 'help center']),
    ]);
    for (const [language, route] of [['en', 'docs/help-center/oauth'], ['fr', 'docs/fr/help-center/oauth']]) {
      const added = tabsOf(navigation, language).find((tab) => tab.tab === 'help center');
      expect(added, language).toBeDefined();
      expect(routesUnder(added)).toEqual([route]);
    }
    // it is a tab because that is what this level holds; nothing else moved
    expect(tabsOf(navigation, 'en').map((tab) => tab.tab)).toEqual(['Documentation', 'help center']);
  });

  it('writes a section front page as the container own page rather than a child repeating its name', () => {
    const { navigation } = build([page('x', 'docs/deploy', ['docs'], 'Deploy overview')]);
    const deploy = (tabsOf(navigation, 'en')[0].groups as Array<Record<string, unknown>>).find((group) => group.group === 'Deploy')!;
    expect(deploy.path).toBe('docs/deploy');
    expect((deploy.pages as Array<Record<string, unknown>>).map((entry) => entry.path)).toEqual(['docs/deploy/vercel', 'docs/deploy/gitlab']);
  });

  it('never reads the site home as a section front page, however many routes sit under it', () => {
    const unplaced: TreePage[] = [];
    buildNavigation([...listed, page('home', 'docs', ['docs'], 'Introduction')], { sourceNavigation, placeUnlisted: true, unplaced });
    expect(unplaced.map((entry) => entry.newPath)).toEqual(['docs']);
  });

  it('reports a page in no folder at all instead of inventing a container for it', () => {
    const unplaced: TreePage[] = [];
    const { navigation } = buildNavigation([...listed, page('x', 'docs/status', ['docs'], 'Status')], { sourceNavigation, placeUnlisted: true, unplaced });
    expect(unplaced.map((entry) => entry.newPath)).toEqual(['docs/status']);
    expect(routesUnder(navigation)).not.toContain('docs/status');
  });
});
