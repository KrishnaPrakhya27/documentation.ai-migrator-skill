/**
 * A deep link is how a reader arrives from a support ticket or a colleague's message. Heading ids
 * change between platforms, and a fragment that no longer matches fails quietly: the page loads,
 * the reader lands at the top, and nothing says so. Anchors used to be checked only against a
 * deployed preview, which is after the push.
 */
import { describe, it, expect } from 'vitest';
import { documentAnchors, unresolvedFragments } from '../src/verify/fragments.js';
import { markdownToIr } from '../src/ir/from-markdown.js';

const parse = (text: string) => ({ doc: markdownToIr(text, { platform: 'dai', file: 'p', pageId: 'p' }), text });
const anchorsOf = (text: string): Set<string> => { const { doc } = parse(text); return documentAnchors(doc, text); };
/** The resolver the gate uses: a path relative to the page it is written on. */
const route = (url: string, from: string): string | undefined => {
  if (!url || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return undefined;
  const path = new URL(url, `https://x.invalid/${from}`).pathname.replace(/^\/+|\/+$/g, '');
  return path || 'index';
};

describe('what a written page offers a deep link', () => {
  it('lists its headings as the renderer slugs them, including repeats', () => {
    expect(anchorsOf('---\ntitle: T\n---\n\n## Configure the agent\n\n### Limits\n\n## Configure the agent\n'))
      .toEqual(new Set(['configure-the-agent', 'limits', 'configure-the-agent-1']));
  });

  it('counts an id written into the page, which is how a renamed heading keeps its old anchor', () => {
    const anchors = anchorsOf('---\ntitle: T\n---\n\n<a id="old-anchor" />\n\n## New heading\n');
    expect(anchors.has('old-anchor')).toBe(true);
    expect(anchors.has('new-heading')).toBe(true);
  });
});

describe('deep links that will not land', () => {
  const anchors = new Map<string, Set<string>>([
    ['guides/install', new Set(['configure-the-agent', 'limits'])],
    ['guides/intro', new Set(['welcome'])],
  ]);

  it('reports a fragment the target page does not have, naming both ends', () => {
    const links = new Map([['guides/intro', ['/guides/install#configure-the-agnet']]]);
    expect(unresolvedFragments(links, anchors, route)).toEqual([
      { from: 'guides/intro', link: '/guides/install#configure-the-agnet', reason: 'guides/install has no anchor "configure-the-agnet"' },
    ]);
  });

  it('passes a fragment that lands, including a link into the page itself', () => {
    const links = new Map([
      ['guides/intro', ['/guides/install#limits', '#welcome']],
      ['guides/install', ['./install#configure-the-agent']],
    ]);
    expect(unresolvedFragments(links, anchors, route)).toEqual([]);
  });

  it('leaves links with no fragment, and links off the site, to the gates that judge those', () => {
    const links = new Map([['guides/intro', ['/guides/install', 'https://example.com/x#frag', 'mailto:a@b.c', '/guides/install#']]]);
    expect(unresolvedFragments(links, anchors, route)).toEqual([]);
  });

  it('says nothing about a page this migration did not write, which internal-links already reports', () => {
    const links = new Map([['guides/intro', ['/guides/not-migrated#somewhere']]]);
    expect(unresolvedFragments(links, anchors, route)).toEqual([]);
  });

  it('decodes a percent-encoded fragment before comparing it', () => {
    const links = new Map([['guides/intro', ['/guides/install#configure%2Dthe%2Dagent']]]);
    expect(unresolvedFragments(links, anchors, route)).toEqual([]);
  });
});
