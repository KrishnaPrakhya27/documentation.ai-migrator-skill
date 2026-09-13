/**
 * Discovery reads a page, acquisition reads it again, and between the two the customer can publish
 * an edit. Mixing the two readings migrates a site that never existed, so the difference has to be
 * noticed — without reporting every page of every site, which a raw byte comparison would do.
 */
import { describe, it, expect } from 'vitest';
import { sourceFingerprint } from '../src/scrape/drift.js';

const page = (body: string, extra = ''): string =>
  `<html><head><meta name="csrf-token" content="abc123">${extra}</head><body>${body}</body></html>`;

describe('what counts as the source changing', () => {
  it('ignores what changes between two loads of an unchanged page', () => {
    const first = page('<p>Install the tool.</p>', '<script>window.__BUILD__="a1";</script><style>.x{color:red}</style>');
    const second = page('<p>Install the tool.</p>', '<script>window.__BUILD__="b2";</script><style>.x{color:blue}</style>');
    expect(sourceFingerprint(first)).toBe(sourceFingerprint(second));
  });

  it('ignores nonces, build markers and comments', () => {
    expect(sourceFingerprint('<div nonce="n1" data-build="7"><!-- rendered 10:02 --><p>Hi</p></div>'))
      .toBe(sourceFingerprint('<div nonce="n2" data-build="8"><!-- rendered 11:45 --><p>Hi</p></div>'));
  });

  it('ignores insignificant whitespace, which a re-render moves around', () => {
    expect(sourceFingerprint('<p>Hi</p>\n\n  <p>There</p>')).toBe(sourceFingerprint('<p>Hi</p> <p>There</p>'));
  });

  it('notices an edit to the words, to a link, or to the structure', () => {
    const base = sourceFingerprint(page('<p>Install the tool.</p>'));
    expect(sourceFingerprint(page('<p>Install the CLI.</p>'))).not.toBe(base);
    expect(sourceFingerprint(page('<p>Install the tool.</p><p>Then run it.</p>'))).not.toBe(base);
    expect(sourceFingerprint(page('<p><a href="/a">Install the tool.</a></p>'))).not.toBe(base);
  });
});
