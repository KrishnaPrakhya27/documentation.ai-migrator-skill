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

describe('a first child that is the group’s own landing page', () => {
  const pages = [page('cat', 'procedures/catalogs/p-catalogs-lp', 'Catalog'), page('a', 'procedures/catalogs/about', 'About'), page('asst', 'docs/assistant', 'Assistant overview'), page('conf', 'docs/assistant/configure', 'Configure'), page('x', 'docs/other', 'Catalog'), page('intro', 'docs', 'Introduction'), page('quick', 'docs/quickstart', 'Quickstart'), page('idx', 'guides/index', 'Welcome'), page('g1', 'guides/first', 'First')];
  const groups = (navigation: SourceNavigationNode[]) => (buildNavigation(pages, { sourceNavigation: navigation }).navigation as { groups: Array<Record<string, unknown>> }).groups;

  it('is lifted to the group’s path when it carries the group’s name', () => {
    expect(groups([{ type: 'group', label: 'Catalog', children: [{ type: 'page', pageId: 'cat' }, { type: 'page', pageId: 'a' }] }]))
      .toEqual([{ group: 'Catalog', path: 'procedures/catalogs/p-catalogs-lp', pages: [{ title: 'About', path: 'procedures/catalogs/about' }] }]);
  });
  it('is lifted when its route is the directory its siblings sit in', () => {
    expect(groups([{ type: 'group', label: 'Assistant', children: [{ type: 'page', pageId: 'asst' }, { type: 'page', pageId: 'conf' }] }]))
      .toEqual([{ group: 'Assistant', path: 'docs/assistant', pages: [{ title: 'Configure', path: 'docs/assistant/configure' }] }]);
  });
  it('stays a child when it is neither named for the group nor at its route, or is not first', () => {
    expect(groups([{ type: 'group', label: 'Catalog', children: [{ type: 'page', pageId: 'a' }, { type: 'page', pageId: 'cat' }] }])[0]).not.toHaveProperty('path');
    expect(groups([{ type: 'group', label: 'Other', children: [{ type: 'page', pageId: 'x' }, { type: 'page', pageId: 'a' }] }])[0]).not.toHaveProperty('path');
  });
  it('is lifted when it is the index of the directory its siblings sit in', () => {
    expect(groups([{ type: 'group', label: 'Guides', children: [{ type: 'page', pageId: 'idx' }, { type: 'page', pageId: 'g1' }] }]))
      .toEqual([{ group: 'Guides', path: 'guides/index', pages: [{ title: 'First', path: 'guides/first' }] }]);
  });
  it('does not lift a site’s root page under its first group, nor a container’s only page', () => {
    expect(groups([{ type: 'group', label: 'Get started', children: [{ type: 'page', pageId: 'intro' }, { type: 'page', pageId: 'quick' }] }])[0]).not.toHaveProperty('path');
    expect(groups([{ type: 'group', label: 'Catalog', children: [{ type: 'page', pageId: 'cat' }] }])).toEqual([{ group: 'Catalog', pages: [{ title: 'Catalog', path: 'procedures/catalogs/p-catalogs-lp' }] }]);
  });
});
