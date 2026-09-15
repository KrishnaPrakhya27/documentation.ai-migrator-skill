/**
 * The serialization check re-parses the MDX it wrote and compares it with the IR it resolved.
 * Markdown cannot express "this ordered list states no start" or "this table aligns nothing" —
 * writing either produces syntax that parses back as an explicit default. Reading that as a
 * difference failed pages whose output was right, so the shapes treat the default and the absence
 * as the same thing, while still comparing anything the source actually stated.
 */
import { describe, it, expect } from 'vitest';
import { renderedDocSnapshot, fidelityEqual } from '../src/verify/fidelity.js';
import type { Block, DocIR } from '../src/ir/types.js';

const doc = (children: Block[]): DocIR => ({ pageId: 'p', platform: 'madcap', source: '/x', frontmatter: { title: 'T' }, children });
const item = (value: string) => ({ id: `li-${value}`, type: 'listItem', children: [{ id: `p-${value}`, type: 'paragraph', children: [{ id: `t-${value}`, type: 'text', value }] }] });
const list = (start?: number): Block => ({ id: 'l', type: 'list', ordered: true, ...(start === undefined ? {} : { start }), children: [item('one'), item('two')] } as unknown as Block);
const cell = (value: string) => ({ id: `c-${value}`, children: [{ id: `ct-${value}`, type: 'text', value }] });
const table = (align?: Array<string | null>): Block => ({ id: 't', type: 'table', ...(align === undefined ? {} : { align }), children: [{ id: 'r', isHeader: true, children: [cell('a'), cell('b')] }] } as unknown as Block);

const image = (url: string) => ({ id: `i-${url}`, type: 'image', url, alt: '' });
const loneImageParagraph = (url: string): Block => ({ id: `p-${url}`, type: 'paragraph', children: [image(url)] } as unknown as Block);
const blockImage = (url: string): Block => ({ id: `b-${url}`, type: 'image', url, alt: '' } as unknown as Block);
const captionedParagraph = (url: string): Block => ({ id: `pc-${url}`, type: 'paragraph', children: [{ id: 't', type: 'text', value: 'click ' }, image(url)] } as unknown as Block);

describe('round-tripping what Markdown cannot leave unsaid', () => {
  it('reads an image alone in a paragraph and a block image as the same image', () => {
    expect(fidelityEqual(renderedDocSnapshot(doc([loneImageParagraph('/a.png')])), renderedDocSnapshot(doc([blockImage('/a.png')])))).toBe(true);
  });

  it('still fails when the image itself changed', () => {
    expect(fidelityEqual(renderedDocSnapshot(doc([loneImageParagraph('/a.png')])), renderedDocSnapshot(doc([blockImage('/b.png')])))).toBe(false);
  });

  it('keeps a paragraph that holds text beside the image, because the text is content', () => {
    expect(fidelityEqual(renderedDocSnapshot(doc([captionedParagraph('/a.png')])), renderedDocSnapshot(doc([blockImage('/a.png')])))).toBe(false);
  });

  it('reads a list that resumes another as the one list Markdown writes', () => {
    const one = renderedDocSnapshot(doc([list(), list(2)]));
    const two = renderedDocSnapshot(doc([{ id: 'l', type: 'list', ordered: true, children: [item('one'), item('two'), item('one'), item('two')] } as unknown as Block]));
    expect(fidelityEqual(one, two)).toBe(true);
  });

  it('reads a paragraph holding only a line break as the blank space it is', () => {
    const br: Block = { id: 'p', type: 'paragraph', children: [{ id: 'b', type: 'break' }] } as unknown as Block;
    const bare: Block = { id: 'c', type: 'component', platform: 'madcap', name: 'br', props: {}, children: [] } as unknown as Block;
    expect(fidelityEqual(renderedDocSnapshot(doc([br])), renderedDocSnapshot(doc([bare])))).toBe(true);
    expect(fidelityEqual(renderedDocSnapshot(doc([br])), renderedDocSnapshot(doc([])))).toBe(true);
  });

  it('reads a list with no items as the nothing Markdown writes for it', () => {
    const empty: Block = { id: 'e', type: 'list', ordered: false, children: [] } as unknown as Block;
    expect(fidelityEqual(renderedDocSnapshot(doc([empty])), renderedDocSnapshot(doc([])))).toBe(true);
  });

  it('still fails a list that lost the items it had', () => {
    const empty: Block = { id: 'e', type: 'list', ordered: true, children: [] } as unknown as Block;
    expect(fidelityEqual(renderedDocSnapshot(doc([list()])), renderedDocSnapshot(doc([empty])))).toBe(false);
  });

  it('reads an ordered list with no stated start and one starting at 1 as the same list', () => {
    expect(fidelityEqual(renderedDocSnapshot(doc([list()])), renderedDocSnapshot(doc([list(1)])))).toBe(true);
  });

  it('still fails a list whose stated start was lost', () => {
    expect(fidelityEqual(renderedDocSnapshot(doc([list(5)])), renderedDocSnapshot(doc([list(1)])))).toBe(false);
    expect(fidelityEqual(renderedDocSnapshot(doc([list(5)])), renderedDocSnapshot(doc([list()])))).toBe(false);
  });

  it('reads a table with no alignment and one whose columns all take the default as the same table', () => {
    expect(fidelityEqual(renderedDocSnapshot(doc([table()])), renderedDocSnapshot(doc([table([null, null])])))).toBe(true);
  });

  it('still fails a table whose stated alignment was lost', () => {
    expect(fidelityEqual(renderedDocSnapshot(doc([table(['center', 'right'])])), renderedDocSnapshot(doc([table([null, null])])))).toBe(false);
    expect(fidelityEqual(renderedDocSnapshot(doc([table(['center', null])])), renderedDocSnapshot(doc([table([null, 'center'])])))).toBe(false);
  });
});
