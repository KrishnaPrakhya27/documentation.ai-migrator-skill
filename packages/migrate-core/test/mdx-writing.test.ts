/**
 * Three ways a written file used to say something the IR did not.
 *
 * Each was found on a real Flare page: a certificate inside an Expandable, a URL holding a template
 * expression, and bold-italic text in a release note.
 */
import { describe, it, expect } from 'vitest';
import { docToMdx, escapeText } from '../src/ir/to-dai-mdx.js';
import { renderedDocSnapshot, fidelityEqual } from '../src/verify/fidelity.js';
import { headingSlug } from '../src/urls/slugger.js';
import type { Block, DocIR } from '../src/ir/types.js';

const doc = (children: Block[]): DocIR => ({ pageId: 'p', platform: 'madcap', source: '/x', frontmatter: { title: 'T' }, children });
const para = (children: unknown[]): Block => ({ id: 'p1', type: 'paragraph', children } as unknown as Block);
const code = (value: string) => ({ id: 'c', type: 'inlineCode', value });
const text = (value: string) => ({ id: 't', type: 'text', value });

describe('what the written file says', () => {
  it('writes a code span that runs over lines as a fence, so nothing indents its lines', () => {
    const mdx = docToMdx(doc([para([code('-----BEGIN CERTIFICATE-----\nMIIDXTCC\n-----END CERTIFICATE-----')])]));
    expect(mdx).toContain('```\n-----BEGIN CERTIFICATE-----\nMIIDXTCC\n-----END CERTIFICATE-----\n```');
  });

  it('reads that fence and the code span it came from as the same block of code', () => {
    const asSpan = renderedDocSnapshot(doc([para([code('one\ntwo')])]));
    const asBlock = renderedDocSnapshot(doc([{ id: 'c2', type: 'code', value: 'one\ntwo' } as unknown as Block]));
    expect(fidelityEqual(asSpan, asBlock)).toBe(true);
  });

  it('writes a web address in prose exactly as the source wrote it, escaping nothing extra', () => {
    // An earlier attempt escaped the scheme's colon to stop the reader linking it. That changed the
    // words on the page, and prose-match caught it: the text a page states is not the writer's to edit.
    expect(escapeText('https://example.com/xyz')).toBe('https://example.com/xyz');
    expect(docToMdx(doc([para([text('See https://example.com/xyz for details.')])]))).toContain('See https://example.com/xyz for details.');
  });

  it('reads a bare address and the link a reader makes of it as the same address said once', () => {
    const asText = renderedDocSnapshot(doc([para([text('https://example.com/xyz')])]));
    const asLink = renderedDocSnapshot(doc([para([{ id: 'l', type: 'link', url: 'https://example.com/xyz', children: [text('https://example.com/xyz')] }])]));
    expect(fidelityEqual(asText, asLink)).toBe(true);
  });

  it('puts back a sentence the reader split at an address it decided to link', () => {
    const stated = renderedDocSnapshot(doc([para([text('https://example.com/{{{ first_name }}}/xyz')])]));
    // what a re-parse makes of the written line: an autolink over the escaped braces, then the rest
    const reread = renderedDocSnapshot(doc([para([
      { id: 'l', type: 'link', url: 'https://example.com/&#123;&#123;&#123', children: [text('https://example.com/&#123;&#123;&#123')] },
      text('; first_name }}}/xyz'),
    ])]));
    expect(fidelityEqual(stated, reread)).toBe(true);
  });

  it('reads an escaped character and the character itself as the same character', () => {
    const escaped = renderedDocSnapshot(doc([para([text('__platform_to_lowercase &lt;email&gt;')])]));
    const plain = renderedDocSnapshot(doc([para([text('__platform_to_lowercase <email>')])]));
    expect(fidelityEqual(escaped, plain)).toBe(true);
  });

  it('still tells two different words apart', () => {
    expect(fidelityEqual(renderedDocSnapshot(doc([para([text('<email>')])])), renderedDocSnapshot(doc([para([text('<name>')])])))).toBe(false);
  });

  it('still compares a link the page gave a label of its own as a link', () => {
    const labelled = renderedDocSnapshot(doc([para([{ id: 'l', type: 'link', url: 'https://example.com/xyz', children: [text('the docs')] }])]));
    const plain = renderedDocSnapshot(doc([para([text('the docs')])]));
    expect(fidelityEqual(labelled, plain)).toBe(false);
  });

  it('reads bold-inside-italic and italic-inside-bold as the one thing `***x***` can say', () => {
    const boldOutside = doc([para([{ id: 's', type: 'strong', children: [{ id: 'e', type: 'emphasis', children: [text('FROM:')] }] }])]);
    const italicOutside = doc([para([{ id: 'e', type: 'emphasis', children: [{ id: 's', type: 'strong', children: [text('FROM:')] }] }])]);
    expect(fidelityEqual(renderedDocSnapshot(boldOutside), renderedDocSnapshot(italicOutside))).toBe(true);
  });
});

/**
 * A heading's id is what every deep link to it must match. A Flare topic wrote "Steps " with a
 * trailing space; the renderer read the heading as trimmed text and gave it `#steps`, while the
 * migration asked the preview for `#steps-` and reported it missing on every page that had one.
 */
describe('the id a heading is given', () => {
  it('ignores space around the heading, as a renderer does', () => {
    expect(headingSlug('Steps ')).toBe('steps');
    expect(headingSlug(' Steps')).toBe('steps');
    expect(headingSlug('Steps')).toBe('steps');
  });

  it('writes the heading without that trailing space', () => {
    const heading = { id: 'h', type: 'heading', depth: 2, children: [{ id: 't', type: 'text', value: 'Steps ' }] } as unknown as Block;
    expect(docToMdx(doc([heading]))).toContain('## Steps\n');
  });
});
