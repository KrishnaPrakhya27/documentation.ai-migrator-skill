/**
 * A migrated site showed the renderer's default name on every page because GitBook declares its
 * name nowhere a crawl reads: no og:site_name, no site config. Its theme does put the name at the
 * end of every `<title>` ("Quickstart | Documentation | demo Docs"), and on the demo-64 capture all
 * 41 pages agreed on "demo Docs".
 *
 * Unanimity is the whole of the evidence. Where pages disagree, or carry no separator at all, the
 * name is not stated and the caller keeps the default rather than inventing one.
 */
import { describe, it, expect } from 'vitest';
import { siteNameFromTitleTags } from '../src/scrape/discovery.js';

describe('siteNameFromTitleTags', () => {
  it('reads the name every decorated title ends with', () => {
    expect(siteNameFromTitleTags([
      'Developer Platform | demo Docs',
      'Getting started | Documentation | demo Docs',
      'Orders | API Reference | demo Docs',
    ])).toBe('demo Docs');
  });

  it('reads a theme that separates with a dash', () => {
    expect(siteNameFromTitleTags(['Setup - Acme Docs', 'Billing - Acme Docs'])).toBe('Acme Docs');
  });

  it('states nothing when the pages disagree', () => {
    expect(siteNameFromTitleTags(['Setup | Acme Docs', 'Billing | Other Docs'])).toBeUndefined();
  });

  it('states nothing when a title carries no separator, so a page title cannot pass as the name', () => {
    expect(siteNameFromTitleTags(['Setup | Acme Docs', 'Billing'])).toBeUndefined();
  });

  it('needs more than one page to call a suffix a name', () => {
    expect(siteNameFromTitleTags(['Setup | Acme Docs'])).toBeUndefined();
  });

  it('ignores pages that state no title at all', () => {
    expect(siteNameFromTitleTags(['Setup | Acme Docs', undefined, '', 'Billing | Acme Docs'])).toBe('Acme Docs');
  });

  it('states nothing for a capture with no titles', () => {
    expect(siteNameFromTitleTags([undefined, undefined])).toBeUndefined();
  });
});
