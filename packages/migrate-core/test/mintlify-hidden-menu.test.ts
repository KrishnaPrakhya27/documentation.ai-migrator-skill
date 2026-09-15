/**
 * Two things a Mintlify site states that the migrated sidebar used to get wrong. A tab marked
 * `hidden` is published but not shown — mintlify.com hides a whole Help center this way — and the
 * sidebar carried it as a tab the reader never saw. A tab built from a `menu` of `item`s, which is
 * what the platform calls dropdowns, had no recognised label and vanished, taking the Learn tab and
 * its guides with it.
 */
import { describe, it, expect } from 'vitest';
import { extractMintlifyNavigation } from '../src/scrape/discovery.js';

const html = (nav: unknown): string => `<html><script>self.__next_f.push([1,${JSON.stringify(`0:${JSON.stringify({ scopedNav: nav })}`)}])</script></html>`;

const SITE = {
  tabs: [
    { tab: 'Documentation', pages: [{ title: 'Home', href: '/' }, { title: 'Quickstart', href: '/quickstart' }] },
    { tab: 'Help center', hidden: true, pages: [{ title: 'Fix the build', href: '/help-center/fix-the-build' }] },
    { tab: 'Learn', menu: [
      { item: 'Learn', description: 'Self-paced lessons.', href: 'https://learn.example.com/' },
      { item: 'Guides', description: 'How-to guides.', groups: [{ group: 'AI', pages: [{ title: 'Build an assistant', href: '/guides/assistant' }] }] },
    ] },
  ],
};

describe('a Mintlify navigation with a hidden tab and a menu', () => {
  const found = extractMintlifyNavigation(html(SITE), 'https://docs.example/')!;

  it('leaves a hidden tab out of the sidebar, as the site does', () => {
    expect(found.navigation.map((node) => node.type === 'group' ? node.label : node.url)).toEqual(['Documentation', 'Learn']);
  });

  it('still discovers the hidden pages, so they migrate and are reported as unlisted', () => {
    expect(found.pages.map((page) => page.url)).toContain('https://docs.example/help-center/fix-the-build');
  });

  it('reads a menu as the dropdowns the platform renders it with', () => {
    expect(found.navigation[1]).toEqual({
      type: 'group', kind: 'tab', label: 'Learn', children: [
        { type: 'group', kind: 'dropdown', label: 'Learn', href: 'https://learn.example.com/', description: 'Self-paced lessons.', children: [] },
        { type: 'group', kind: 'dropdown', label: 'Guides', description: 'How-to guides.', children: [
          { type: 'group', label: 'AI', children: [{ type: 'page', url: 'https://docs.example/guides/assistant', title: 'Build an assistant' }] },
        ] },
      ],
    });
  });
});
