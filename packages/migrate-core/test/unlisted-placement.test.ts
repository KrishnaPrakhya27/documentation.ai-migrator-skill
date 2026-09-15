/**
 * Documentation.AI serves only the routes its navigation names. A page written into the repository
 * and left out of the navigation answers 404 — which is what happened to 252 of a Flare site's 427
 * pages, because that site's own sidebar named only 175 of them.
 *
 * Placing them states a structure the source's sidebar does not, so it is an operator's decision;
 * what it places them under is read from the folders the source publishes them in.
 */
import { describe, it, expect } from 'vitest';
import { buildDocumentationNavigation, type Tree, type TreePage } from '../src/nav/tree.js';

const page = (id: string, path: string, title: string, group: string[], order: number): TreePage => ({ id, title, source: `https://x.test/${path}.htm`, group, order, migrate: true, newPath: path } as unknown as TreePage);
const listed = page('p1', 'procedures/one', 'One', ['Procedures'], 0);
const unlisted = [
  page('p2', 'reference/two', 'Two', ['Reference'], 1),
  page('p3', 'reference/restrictions/three', 'Three', ['Reference', 'Restrictions'], 2),
];
const tree = (extra: Partial<Tree> = {}): Tree => ({
  scope: 'full', platform: 'madcap',
  pages: [listed, ...unlisted],
  navigation: [{ type: 'page', pageId: 'p1', url: 'https://x.test/procedures/one.htm', title: 'One' }],
  navigationSource: 'platform-metadata',
  ...extra,
} as unknown as Tree);
const written = new Set(['procedures/one', 'reference/two', 'reference/restrictions/three']);
const paths = (nav: unknown): string[] => {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node && typeof node === 'object') { const o = node as Record<string, unknown>; if (typeof o.path === 'string') out.push(o.path); for (const v of Object.values(o)) walk(v); }
  };
  walk(nav);
  return out;
};

describe('pages the source sidebar never named', () => {
  it('are left out while no one has decided where they go', () => {
    expect(paths(buildDocumentationNavigation(tree(), written, {}))).toEqual(['procedures/one']);
  });

  it('are placed under the folders the source publishes them in, once decided', () => {
    const decided = tree({ unlistedPlacement: { strategy: 'source-path', approvedBy: 'operator', approvedAt: '2026-09-15T00:00:00.000Z' } });
    const placed = paths(buildDocumentationNavigation(decided, written, {}));
    expect(placed).toContain('procedures/one');
    expect(placed).toContain('reference/two');
    expect(placed).toContain('reference/restrictions/three');
  });

  it('keeps the source-stated navigation first and unchanged', () => {
    const decided = tree({ unlistedPlacement: { strategy: 'source-path', approvedBy: 'operator', approvedAt: '2026-09-15T00:00:00.000Z' } });
    expect(paths(buildDocumentationNavigation(decided, written, {}))[0]).toBe('procedures/one');
  });

  it('is a decision, so a tree rebuilt from the same bytes must not quietly drop it', () => {
    // discover --offline derives structure again; what an operator decided is not structure.
    const decided = tree({ unlistedPlacement: { strategy: 'source-path', approvedBy: 'operator', approvedAt: '2026-09-15T00:00:00.000Z' } });
    const rebuilt = tree();
    rebuilt.unlistedPlacement = decided.unlistedPlacement;
    rebuilt.navigationSource = 'manual';
    expect(paths(buildDocumentationNavigation(rebuilt, written, {})).length).toBe(3);
  });

  it('nests them by the source folders rather than flattening them', () => {
    const decided = tree({ unlistedPlacement: { strategy: 'source-path', approvedBy: 'operator', approvedAt: '2026-09-15T00:00:00.000Z' } });
    const nav = JSON.stringify(buildDocumentationNavigation(decided, written, {}));
    expect(nav).toContain('"group":"Reference"');
    expect(nav).toContain('"group":"Restrictions"');
  });
});
