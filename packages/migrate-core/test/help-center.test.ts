/**
 * A help centre migrated as topic pages reads as product documentation. The platform's own pattern
 * is a container opening on a hub of category cards drawn from the navigation, and an operator can
 * declare a container to be one. The migration writes no words for it: the hub is the container's
 * label and one dynamic component.
 */
import { describe, it, expect } from 'vitest';
import { attachHelpCenterHub, defaultHubPath, helpCenterHubMdx } from '../src/nav/help-center.js';
import { buildDocumentationNavigation, type Tree } from '../src/nav/tree.js';
import { validateMdx } from '@dai/content-contract';

const NAV = { tabs: [
  { tab: 'Documentation', pages: [{ title: 'Home', path: 'home' }] },
  { tab: 'Help center', groups: [{ group: 'Billing', pages: [{ title: 'Refunds', path: 'help/refunds' }] }] },
] };

describe('a container declared a help centre', () => {
  it('opens on the hub, and is addressed by its node path', () => {
    const { navigation, hubs } = attachHelpCenterHub(NAV, { container: 'Help center', hubPath: 'help-center/index' });
    expect(hubs).toEqual([{ nodePath: 'tabs:Help center', hubPath: 'help-center/index' }]);
    expect((navigation.tabs as Array<Record<string, unknown>>)[1]).toMatchObject({ tab: 'Help center', path: 'help-center/index' });
    // nothing else moved
    expect((navigation.tabs as Array<Record<string, unknown>>)[0]).toEqual(NAV.tabs[0]);
  });

  it('is found under a language, with the path that names it there', () => {
    const nested = { languages: [{ language: 'en', ...NAV }] };
    expect(attachHelpCenterHub(nested, { container: 'Help center', hubPath: 'h/index' }).hubs).toEqual([{ nodePath: 'languages:en/tabs:Help center', hubPath: 'h/index' }]);
  });

  it('opens the same section in every language it is published in, each at the head of its own pages', () => {
    const perLanguage = { languages: [
      { language: 'en', tabs: [{ tab: 'Help center', pages: [{ title: 'Refunds', path: 'docs/help-center/refunds' }] }] },
      { language: 'fr', tabs: [{ tab: 'Help center', pages: [{ title: 'Remboursements', path: 'docs/fr/help-center/remboursements' }] }] },
    ] };
    const { navigation, hubs } = attachHelpCenterHub(perLanguage, { container: 'Help center' });
    expect(hubs).toEqual([
      { nodePath: 'languages:en/tabs:Help center', hubPath: 'docs/help-center/index' },
      { nodePath: 'languages:fr/tabs:Help center', hubPath: 'docs/fr/help-center/index' },
    ]);
    const paths = (navigation.languages as Array<Record<string, unknown>>).map((language) => (language.tabs as Array<Record<string, unknown>>)[0].path);
    expect(paths).toEqual(['docs/help-center/index', 'docs/fr/help-center/index']);
  });

  it('refuses a container the navigation does not hold, naming the ones it does', () => {
    expect(() => attachHelpCenterHub(NAV, { container: 'Support', hubPath: 'x' })).toThrow(/no navigation container is labelled "Support"; the containers are: tabs:Documentation, tabs:Help center/);
  });

  it('writes a hub page that is valid on the platform and holds no prose', () => {
    const mdx = helpCenterHubMdx({ container: 'Help center' }, 'tabs:Help center');
    expect(mdx).toBe('---\ntitle: "Help center"\n---\n\n<CollectionList node="tabs:Help center" layout="cards" cols={2} />\n');
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
