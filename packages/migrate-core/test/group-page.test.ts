/**
 * A group the source gives a page of its own — a GitBook parent page, a Flare topic with subtopics,
 * a Mintlify page with subpages — opens as that page when clicked. The platform reads that from the
 * container's `path`. Writing the page as a duplicate first entry beneath the group instead put two
 * sidebar rows where the source had one, and read back as a structure the source never stated.
 */
import { describe, it, expect } from 'vitest';
import { buildNavigation, placedPageIds, type SourceNavigationNode, type TreePage } from '../src/nav/tree.js';
import { validateNavigation } from '@dai/content-contract';

const page = (id: string, newPath: string, title = id): TreePage => ({ id, title, source: `${id}.md`, group: [], order: 0, oldPath: `/${newPath}`, newPath, migrate: true, reason: 'sidebar' });

describe('a group that is itself a page', () => {
  const pages = [page('guides', 'guides', 'Guides'), page('a', 'guides/a', 'A'), page('b', 'guides/b', 'B')];

  it('is written as the container with a path, with the page nowhere else', () => {
    const navigation: SourceNavigationNode[] = [{ type: 'group', label: 'Guides', pageId: 'guides', children: [{ type: 'page', pageId: 'a' }, { type: 'page', pageId: 'b' }] }];
    const built = buildNavigation(pages, { sourceNavigation: navigation }).navigation as { groups: Array<Record<string, unknown>> };
    expect(built.groups).toEqual([{ group: 'Guides', path: 'guides', pages: [{ title: 'A', path: 'guides/a' }, { title: 'B', path: 'guides/b' }] }]);
  });

  it('is a page when nothing else is left beneath it', () => {
    const navigation: SourceNavigationNode[] = [{ type: 'group', label: 'Guides', pageId: 'guides', children: [] }];
    const built = buildNavigation(pages, { sourceNavigation: navigation }).navigation as { pages: Array<Record<string, unknown>> };
    expect(built.pages).toEqual([{ title: 'Guides', path: 'guides' }]);
  });

  it('counts as placed, so the page is not reported as missing from the sidebar', () => {
    expect(placedPageIds([{ type: 'group', label: 'Guides', pageId: 'guides', children: [{ type: 'page', pageId: 'a' }] }])).toEqual(new Set(['guides', 'a']));
  });

  it('is validated like any other path', () => {
    const exists = (path: string) => path === 'guides/a';
    const doc = (path: string) => ({ name: 'Docs', navigation: { groups: [{ group: 'Guides', path, pages: [{ title: 'A', path: 'guides/a' }] }] } });
    expect(validateNavigation(doc('guides'), exists).map((issue) => issue.message)).toEqual(['navigation.groups[0]: group path "guides" has no file']);
    expect(validateNavigation(doc('guides/a'), exists)).toEqual([]);
  });
});
