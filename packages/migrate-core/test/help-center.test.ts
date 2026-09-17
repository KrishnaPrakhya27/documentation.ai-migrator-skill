/**
 * A help centre migrated as topic pages reads as product documentation. The platform's own pattern
 * is a container opening on a hub of category cards drawn from the navigation, and an operator can
 * declare a container to be one. The migration writes no words for it: the hub is the container's
 * label and one dynamic component.
 */
import { describe, it, expect } from 'vitest';
import { attachHelpCenterHub, defaultHubPath, helpCenterHubMdx } from '../src/nav/help-center.js';
import { buildDocumentationNavigation, type Tree } from '../src/nav/tree.js';
import { validateMdx, validateNavigation } from '@dai/content-contract';

const NAV = { tabs: [
  { tab: 'Documentation', pages: [{ title: 'Home', path: 'home' }] },
  { tab: 'Help center', groups: [{ group: 'Billing', pages: [{ title: 'Refunds', path: 'help/refunds' }] }] },
] };

describe('a container declared a help centre', () => {
  it('opens on the hub, and is addressed by its node path', () => {
    const { navigation, hubs } = attachHelpCenterHub(NAV, { container: 'Help center', hubPath: 'help-center/index' });
    // all the tab holds is one group, so the hub lists that group's articles rather than a single card
    expect(hubs).toEqual([{ nodePath: 'tabs:Help center', hubPath: 'help-center/index', label: 'Help center', listNode: 'tabs:Help center/groups:Billing', cols: 2 }]);
    expect((navigation.tabs as Array<Record<string, unknown>>)[1]).toMatchObject({ tab: 'Help center', path: 'help-center/index' });
    // nothing else moved
    expect((navigation.tabs as Array<Record<string, unknown>>)[0]).toEqual(NAV.tabs[0]);
  });

  it('is found under a language, with the path that names it there', () => {
    const nested = { languages: [{ language: 'en', ...NAV }] };
    expect(attachHelpCenterHub(nested, { container: 'Help center', hubPath: 'h/index' }).hubs).toMatchObject([{ nodePath: 'languages:en/tabs:Help center', hubPath: 'h/index' }]);
  });

  it('opens the same section in every language it is published in, each at the head of its own pages', () => {
    const perLanguage = { languages: [
      { language: 'en', tabs: [{ tab: 'Help center', pages: [{ title: 'Refunds', path: 'docs/help-center/refunds' }] }] },
      { language: 'fr', tabs: [{ tab: 'Help center', pages: [{ title: 'Remboursements', path: 'docs/fr/help-center/remboursements' }] }] },
    ] };
    const { navigation, hubs } = attachHelpCenterHub(perLanguage, { container: 'Help center' });
    expect(hubs).toMatchObject([
      { nodePath: 'languages:en/tabs:Help center', hubPath: 'docs/help-center/index' },
      { nodePath: 'languages:fr/tabs:Help center', hubPath: 'docs/fr/help-center/index' },
    ]);
    const paths = (navigation.languages as Array<Record<string, unknown>>).map((language) => (language.tabs as Array<Record<string, unknown>>)[0].path);
    expect(paths).toEqual(['docs/help-center/index', 'docs/fr/help-center/index']);
  });

  it('refuses a container the navigation does not hold, naming the ones it does', () => {
    expect(() => attachHelpCenterHub(NAV, { container: 'Support', hubPath: 'x' })).toThrow(/no navigation container is labelled "Support"; the containers are: tabs:Documentation, tabs:Help center/);
  });

  it('finds the same section under the name each language gives it, by where its pages sit', () => {
    const translated = { languages: [
      // the default language's home page is the site root itself, `docs`, and French's is `docs/fr`
      { language: 'en', tabs: [{ tab: 'Documentation', pages: [{ title: 'Home', path: 'docs' }, { title: 'Quickstart', path: 'docs/quickstart' }] }, { tab: 'Help center', pages: [{ title: 'Refunds', path: 'docs/help-center/refunds' }] }] },
      { language: 'fr', tabs: [{ tab: 'Documentation', pages: [{ title: 'Accueil', path: 'docs/fr' }, { title: 'Démarrage', path: 'docs/fr/quickstart' }] }, { tab: "Centre d'aide", pages: [{ title: 'Remboursements', path: 'docs/fr/help-center/remboursements' }] }] },
    ] };
    const { navigation, hubs } = attachHelpCenterHub(translated, { container: 'Help center' });
    expect(hubs.map((hub) => [hub.label, hub.hubPath])).toEqual([['Help center', 'docs/help-center/index'], ["Centre d'aide", 'docs/fr/help-center/index']]);
    // each hub is titled in its own language, and the other tabs are untouched
    expect(helpCenterHubMdx(hubs[1])).toContain(`title: "Centre d'aide"`);
    const french = (navigation.languages as Array<{ tabs: Array<Record<string, unknown>> }>)[1].tabs;
    expect(french[0]).toEqual(translated.languages[1].tabs[0]);
    expect(french[1]).toMatchObject({ tab: "Centre d'aide", path: 'docs/fr/help-center/index' });
  });

  it('looks like a help centre: the help icon where the source gives none, flat sections, and a hub that opens as a front door', () => {
    const { navigation } = attachHelpCenterHub(NAV, { container: 'Help center', hubPath: 'help-center/index' });
    expect((navigation.tabs as Array<Record<string, unknown>>)[1]).toEqual({
      tab: 'Help center', icon: 'circle-help', path: 'help-center/index',
      'show-toc': false, 'show-page-navigation': false, 'ask-feedback': false, 'content-width': 'wide',
      groups: [{ group: 'Billing', expandable: false, pages: [{ title: 'Refunds', path: 'help/refunds' }] }],
    });
    // what the source states is kept: its own icon, its own choice of accordion
    const stated = { tabs: [{ tab: 'Help center', icon: 'life-buoy', groups: [{ group: 'Billing', expandable: true, pages: [{ title: 'Refunds', path: 'help/refunds' }] }] }] };
    const kept = (attachHelpCenterHub(stated, { container: 'Help center' }).navigation.tabs as Array<Record<string, unknown>>)[0];
    expect(kept.icon).toBe('life-buoy');
    expect((kept.groups as Array<Record<string, unknown>>)[0].expandable).toBe(true);
    expect(validateNavigation({ name: 'Docs', navigation }, () => true)).toEqual([]);
  });

  it('writes a hub page that is valid on the platform and holds no prose', () => {
    const mdx = helpCenterHubMdx({ label: 'Help center', listNode: 'tabs:Help center', cols: 3 });
    expect(mdx).toBe('---\ntitle: "Help center"\n---\n\n<CollectionList node="tabs:Help center" layout="cards" cols={3} />\n');
    expect(validateMdx(mdx)).toEqual([]);
    expect(defaultHubPath('Help center')).toBe('help-center/index');
  });

  it('is carried by the tree, so verification re-derives the same navigation', () => {
    const tree: Tree = {
      scope: 'full', platform: 'mintlify',
      pages: [{ id: 'r', title: 'Refunds', source: 'r.md', group: [], order: 0, oldPath: '/help/refunds', newPath: 'help/refunds', migrate: true, reason: 'sidebar' }],
      navigation: [{ type: 'group', kind: 'tab', label: 'Help center', children: [{ type: 'group', label: 'Billing', children: [{ type: 'page', pageId: 'r' }] }] }],
      helpCenter: { container: 'Help center', hubPath: 'help-center/index', approvedBy: 'ops', approvedAt: '2026-09-15T00:00:00.000Z' },
    };
    const built = buildDocumentationNavigation(tree, new Set(['help/refunds']), {}).navigation as { tabs: Array<Record<string, unknown>> };
    expect(built.tabs[0]).toMatchObject({ tab: 'Help center', path: 'help-center/index' });
  });
});
