/**
 * What a source states about how an entry looks — its icon, its sidebar tag, its HTTP method, its
 * page layout — is presentation, and the platform has a place for each on the navigation entry.
 * None of it reached documentation.json: icons and methods were never captured from a live site,
 * and an icon name the renderer's library does not have drew nothing, in silence.
 */
import { describe, it, expect } from 'vitest';
import { validateNavigation } from '@dai/content-contract';
import { extractMintlifyNavigation } from '../src/scrape/discovery.js';
import { buildNavigation, sourceNavigationFromDiscovered, type SourceNavigationNode, type TreePage } from '../src/nav/tree.js';
import { labelFromPathSegment, statedLabelsBySlug } from '../src/nav/labels.js';

const html = (nav: unknown): string => `<html><script>self.__next_f.push([1,${JSON.stringify(`0:${JSON.stringify({ scopedNav: nav })}`)}])</script></html>`;
const page = (id: string, newPath: string, extra: Partial<TreePage> = {}): TreePage => ({ id, title: id, source: `https://docs.example/${newPath}`, group: [], order: 0, migrate: true, newPath, ...extra });

describe('presentation a Mintlify site states on its navigation entries', () => {
  const found = extractMintlifyNavigation(html({ groups: [
    { group: 'Start', icon: 'rocket', href: null, description: null, pages: [
      { title: 'Home', href: '/', mode: 'frame' },
      { title: 'Quickstart', href: '/quickstart', icon: 'gear', tag: 'NEW' },
      { title: 'Create a pet', href: '/api/create-pet', openapi: 'openapi.json POST /pet' },
    ] },
  ] }), 'https://docs.example/')!;

  it('reads a page entry\'s icon, tag, layout mode and the method of the operation it names', () => {
    const group = found.navigation[0] as Extract<(typeof found.navigation)[number], { type: 'group' }>;
    expect(group.children).toEqual([
      { type: 'page', url: 'https://docs.example/', title: 'Home', mode: 'frame' },
      { type: 'page', url: 'https://docs.example/quickstart', title: 'Quickstart', icon: 'gear', badge: 'NEW' },
      { type: 'page', url: 'https://docs.example/api/create-pet', title: 'Create a pet', method: 'POST' },
    ]);
  });

  it('does not carry the nulls Flight data states for an absent value', () => {
    expect(found.navigation[0]).not.toHaveProperty('href');
    expect(found.navigation[0]).not.toHaveProperty('description');
  });

  it('writes each under the name and in the place the platform reads it', () => {
    const ids: Record<string, string> = { 'https://docs.example/': 'home', 'https://docs.example/quickstart': 'quick', 'https://docs.example/api/create-pet': 'pet' };
    const navigation = sourceNavigationFromDiscovered(found.navigation, (url) => ids[url]);
    const pages = [page('home', 'index'), page('quick', 'quickstart'), page('pet', 'api/create-pet')];
    const built = buildNavigation(pages, { sourceNavigation: navigation });
    expect(built.navigation).toEqual({ groups: [{ group: 'Start', icon: 'rocket', pages: [
      // Mintlify's frame mode: a canvas that keeps the sidebar
      { title: 'Home', path: 'index', 'show-toc': false, 'show-parent-label': false, 'show-page-navigation': false, 'ask-feedback': false, 'content-width': 'wide' },
      // Font Awesome's `gear` is Lucide's `settings`; the tag is the platform's badge
      { title: 'Quickstart', path: 'quickstart', icon: 'settings', badge: 'NEW' },
      { title: 'Create a pet', path: 'api/create-pet', method: 'POST' },
    ] }] });
    expect(validateNavigation({ name: 'Docs', ...built }, () => true)).toEqual([]);
  });
});

describe('an icon the renderer cannot draw', () => {
  const nav = (icon: string): SourceNavigationNode[] => [{ type: 'group', label: 'Guides', icon, children: [{ type: 'page', pageId: 'a' }] }];
  const groupOf = (icon: string): Record<string, unknown> => (buildNavigation([page('a', 'a')], { sourceNavigation: nav(icon) }).navigation as { groups: Array<Record<string, unknown>> }).groups[0];

  it('is written under the name the renderer\'s library draws the same picture by', () => {
    // lucide-react 0.525 has no `file-braces`: it is the newer name of `file-json`
    expect(groupOf('file-braces').icon).toBe('file-json');
    expect(groupOf('magnifying-glass').icon).toBe('search');
    expect(groupOf('book-open').icon).toBe('book-open');
  });

  it('is not written at all when the library has nothing for it', () => {
    expect(groupOf('claude')).not.toHaveProperty('icon');
    expect(groupOf('https://cdn.example/icon.svg')).not.toHaveProperty('icon');
  });
});

describe('what a container may state', () => {
  it('keeps a description on a dropdown and leaves it off a tab, which has none', () => {
    const navigation: SourceNavigationNode[] = [{ type: 'group', kind: 'tab', label: 'Learn', description: 'Everything to learn', children: [
      { type: 'group', kind: 'dropdown', label: 'Guides', description: 'How-to guides.', children: [{ type: 'page', pageId: 'a' }] },
    ] }];
    const built = buildNavigation([page('a', 'a')], { sourceNavigation: navigation });
    expect(built.navigation).toEqual({ tabs: [{ tab: 'Learn', dropdowns: [{ dropdown: 'Guides', description: 'How-to guides.', pages: [{ title: 'a', path: 'a' }] }] }] });
    expect(validateNavigation({ name: 'Docs', ...built }, () => true)).toEqual([]);
  });
});

describe('a site with versions and languages', () => {
  it('is written version first: the platform nests a language inside a version, never the reverse', () => {
    const pages = [page('a', 'v1/en/a', { version: 'v1', locale: 'en' }), page('b', 'v1/fr/b', { version: 'v1', locale: 'fr' }), page('c', 'v2/en/c', { version: 'v2', locale: 'en' })];
    const built = buildNavigation(pages, { defaultVersion: 'v2', defaultLocale: 'en' });
    expect(built.navigation).toEqual({ versions: [
      { version: 'v2', languages: [{ language: 'en', pages: [{ title: 'c', path: 'v2/en/c' }] }] },
      { version: 'v1', languages: [{ language: 'en', pages: [{ title: 'a', path: 'v1/en/a' }] }, { language: 'fr', pages: [{ title: 'b', path: 'v1/fr/b' }] }] },
    ] });
    expect(validateNavigation({ name: 'Docs', ...built }, () => true)).toEqual([]);
  });
});

describe('a label for a folder the source never named', () => {
  it('reads the slug as words in sentence case, with documentation abbreviations in capitals', () => {
    expect(labelFromPathSegment('help-center')).toBe('Help center');
    expect(labelFromPathSegment('api-reference')).toBe('API reference');
    expect(labelFromPathSegment('sdks')).toBe('SDKs');
    expect(labelFromPathSegment('MyProduct')).toBe('MyProduct');
  });

  it('takes the source\'s own label where the source names a container by that slug, hidden or not', () => {
    const stated = statedLabelsBySlug([{ type: 'group', label: 'Docs', children: [{ type: 'group', label: 'Help Center', hidden: true, children: [] }] }]);
    expect(labelFromPathSegment('help-center', stated)).toBe('Help Center');
  });
});
