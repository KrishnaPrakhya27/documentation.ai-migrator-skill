/**
 * The platform's paths are ASCII kebab-case. An accented Latin title transliterates cleanly, but a
 * title written in another script has nothing to transliterate to and used to fall back to the
 * literal "page" — so a Japanese or Russian site migrated as page, page-2, page-3, losing every URL
 * it had and reporting nothing. A route that cannot be carried is now asked for, never invented.
 */
import { describe, it, expect } from 'vitest';
import { slugify, slugifySegment, legalisePath } from '../src/urls/slugger.js';
import { defaultUrlPlan } from '../src/urls/plan.js';
import type { Tree, TreePage } from '../src/nav/tree.js';

const page = (over: Partial<TreePage>): TreePage => ({
  id: over.id ?? 'p', title: over.title ?? 'Page', source: over.source ?? '/src', group: over.group ?? [],
  order: 0, migrate: true, ...over,
});
const tree = (pages: TreePage[]): Tree => ({ scope: 'full', platform: 'generic', pages });

describe('routes the slug rules cannot carry', () => {
  it('transliterates accented Latin, which loses nothing a reader needs', () => {
    expect(slugify('Guía de inicio')).toBe('guia-de-inicio');
    expect(slugify('Überblick')).toBe('uberblick');
    expect(slugifySegment('Guía').erased).toBe(false);
  });

  it('reports a title it erased rather than pretending it produced a route', () => {
    for (const title of ['Введение', '日本語ガイド', '한국어', 'العربية']) {
      expect(slugifySegment(title), title).toMatchObject({ slug: 'page', erased: true });
    }
    // punctuation alone was never a route, and is not an erasure
    expect(slugifySegment('---').erased).toBe(false);
    expect(slugifySegment('').erased).toBe(false);
  });

  it('names the erased segments of a path', () => {
    expect(legalisePath('/docs/введение/начало', { case: 'preserve' })).toMatchObject({
      path: 'docs/page/page', erased: ['введение', 'начало'],
    });
    expect(legalisePath('/docs/guia', { case: 'preserve' }).erased).toBeUndefined();
  });

  it('lists every page whose route was erased, from its path and from its title', () => {
    const preserve = defaultUrlPlan(tree([
      page({ id: 'ru', title: 'Введение', oldPath: '/docs/введение', source: '/docs/введение' }),
      page({ id: 'en', title: 'Overview', oldPath: '/docs/overview', source: '/docs/overview' }),
    ]));
    expect(preserve.erased?.map((entry) => entry.id)).toEqual(['ru']);

    const restructure = defaultUrlPlan(tree([page({ id: 'ja', title: '日本語ガイド', group: ['ガイド'] })]), { mode: 'restructure' });
    expect(restructure.erased?.[0]).toMatchObject({ id: 'ja', segments: ['ガイド', '日本語ガイド'] });
  });

  it('says nothing when every route survives', () => {
    expect(defaultUrlPlan(tree([page({ id: 'a', title: 'Overview', oldPath: '/overview' })])).erased).toBeUndefined();
  });
});
