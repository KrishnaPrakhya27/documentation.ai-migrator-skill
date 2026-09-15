/**
 * A Flare topic names its own top with an anchor inside the title heading (`<h1><a name="top">`),
 * and sibling pages link to `page#top`. That heading becomes the frontmatter title and leaves the
 * body, so without care the address the source published disappears with it. The anchor is not put
 * back as content — it is a link target, and a page states nothing by having one.
 */
import { describe, it, expect } from 'vitest';
import { anchorMap } from '../src/urls/plan.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import type { DocIR } from '../src/ir/types.js';

const page = (titleAnchor?: string) => [{ pageId: 'p1', headings: [{ id: 'h2a', text: 'A section', sourceId: 'Sect' }], ...(titleAnchor ? { titleAnchor } : {}) }];
const doc: DocIR = { pageId: 'p1', platform: 'madcap', source: '/x.htm', frontmatter: { title: 'About the profile' }, children: [{ id: 'p', type: 'paragraph', children: [{ id: 't', type: 'text', value: 'Body.' }] }] } as unknown as DocIR;

describe('the anchor a title heading published', () => {
  it('is kept for the page when something links to it', () => {
    const { leading } = anchorMap(page('top'), new Map([['p1#top', 2]]));
    expect(leading.get('p1')).toBe('top');
  });

  it('is left out when nothing links to it, so pages do not collect dead markup', () => {
    expect(anchorMap(page('top'), new Map()).leading.has('p1')).toBe(false);
  });

  it('is absent for a page whose title heading carried no anchor', () => {
    expect(anchorMap(page(), new Map([['p1#top', 2]])).leading.has('p1')).toBe(false);
  });

  it('is written at the head of the body, before the content', () => {
    const mdx = docToMdx(doc, { leadingAnchor: 'top' });
    expect(mdx).toContain('<a id="top"></a>');
    expect(mdx.indexOf('<a id="top"></a>')).toBeLessThan(mdx.indexOf('Body.'));
  });

  it('writes nothing when there is no anchor to keep', () => {
    expect(docToMdx(doc)).not.toContain('<a id=');
  });
});
