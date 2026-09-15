/**
 * Flare names a cross-reference target with an empty anchor inside the heading, and the page's own
 * links point at it. A surveyed page carried 8 such anchors and 153 links across the site landed on
 * them; reading only the heading's own `id` left every one of those links pointing at nothing.
 */
import { describe, it, expect } from 'vitest';
import { htmlToIr } from '../src/ir/from-html.js';
import { getProfile, htmlAdapterOptions } from '../src/scrape/profiles.js';
import { documentLinks } from '../src/verify/source-truth.js';

const ir = (body: string) => htmlToIr(`<html data-mc-path-to-help-system=""><body><div data-mc-content-body="True">${body}</div></body></html>`, htmlAdapterOptions(getProfile('madcap'), { platform: 'madcap', file: 'topic.htm' }));
const headings = (body: string) => ir(body).children.filter((block): block is Extract<typeof block, { type: 'heading' }> => block.type === 'heading');

describe('a heading whose anchor is a named anchor inside it', () => {
  it('takes the named anchor as its source anchor, so links to it still land', () => {
    const [heading] = headings('<h2><a name="Member"></a>Member activity information</h2>');
    expect(heading.sourceId).toBe('Member');
    // the anchor is the heading's source id, not a second copy sitting in its text
    expect(heading.children.map((inline) => ('value' in inline ? inline.value : '')).join('')).toBe('Member activity information');
  });

  it('prefers the heading\'s own id when it states one', () => {
    expect(headings('<h2 id="real"><a name="legacy"></a>Section</h2>')[0].sourceId).toBe('real');
  });

  it('accepts an empty anchor that uses id rather than name', () => {
    expect(headings('<h2><a id="Tier"></a>Tier</h2>')[0].sourceId).toBe('Tier');
  });

  it('leaves a heading with no anchor alone', () => {
    expect(headings('<h2>Plain heading</h2>')[0].sourceId).toBeUndefined();
  });

  it('keeps a named anchor in body text as an empty target, so links to it still land', () => {
    const [paragraph] = ir('<p><a name="addition1"><strong>ADDED JAN 3:</strong></a> Fixed an issue.</p>').children as Array<{ children: Array<{ type: string; value?: string }> }>;
    expect(paragraph.children[0]).toMatchObject({ type: 'inlineHtml', value: '<a id="addition1"></a>' });
    const text = JSON.stringify(paragraph);
    expect(text).toContain('ADDED JAN 3:');
    expect(text).toContain('Fixed an issue.');
  });

  it('keeps the other anchors when a heading names more than one spot', () => {
    const [heading] = ir('<h2><a name="NoticeofUpcomingDeprecations"></a><a name="deprecations"></a>Notice of Upcoming Deprecations</h2>').children as Array<{ sourceId?: string; children: Array<{ type: string; value?: string }> }>;
    expect(heading.sourceId).toBe('NoticeofUpcomingDeprecations');
    expect(heading.children[0]).toMatchObject({ type: 'inlineHtml', value: '<a id="deprecations"></a>' });
  });

  it('does not mistake a real link inside a heading for an anchor', () => {
    expect(headings('<h2><a href="/other.htm">Linked heading</a></h2>')[0].sourceId).toBeUndefined();
  });
});

/**
 * An anchor shim is kept only where something links to the anchor. A page's own contents table
 * links to its sections from inside table cells, so counting only the links sitting directly in a
 * paragraph left those sections without a shim while the fragment check — which reads every link —
 * reported them as broken.
 */
describe('the links that decide whether an anchor keeps its shim', () => {
  const doc = (children: unknown[]) => ({ pageId: 'p', platform: 'madcap', source: '/x', frontmatter: { title: 'T' }, children }) as Parameters<typeof documentLinks>[0];
  const link = (url: string) => ({ id: `l-${url}`, type: 'link', url, children: [{ id: `t-${url}`, type: 'text', value: url }] });

  it('finds a link inside a table cell, as a page contents table states it', () => {
    const table = { id: 'tb', type: 'table', children: [{ id: 'r', isHeader: false, children: [{ id: 'c', children: [link('#At-at-a')] }] }] };
    expect(documentLinks(doc([table]))).toContain('#At-at-a');
  });

  it('finds a link inside a list item', () => {
    const list = { id: 'l', type: 'list', ordered: false, children: [{ id: 'li', type: 'listItem', children: [{ id: 'p1', type: 'paragraph', children: [link('#Member')] }] }] };
    expect(documentLinks(doc([list]))).toContain('#Member');
  });

  it('finds a link nested inside inline formatting', () => {
    const paragraph = { id: 'p1', type: 'paragraph', children: [{ id: 's', type: 'strong', children: [link('#SVC')] }] };
    expect(documentLinks(doc([paragraph]))).toContain('#SVC');
  });
});
