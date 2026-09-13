/**
 * Column alignment is authored content: a right-aligned numeric column read as left-aligned is a
 * table the source never wrote. Markdown sources carry it already; an HTML source states it on the
 * cells, where it was being dropped silently.
 */
import { describe, it, expect } from 'vitest';
import { htmlToIr } from '../src/ir/from-html.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import type { DocIR } from '../src/ir/types.js';

const ir = (html: string) => htmlToIr(html, { platform: 'generic', file: 'p.html' });
const mdx = (html: string): string => docToMdx({ pageId: 'p', frontmatter: { title: 'T' }, children: ir(html).children, headings: [], images: [] } as unknown as DocIR);

describe('HTML table alignment', () => {
  it('reads alignment from the align attribute and from text-align, per column', () => {
    const table = ir('<table><tr><th>Name</th><th align="right">Count</th><th style="text-align:center">State</th></tr>'
      + '<tr><td>a</td><td align="right">1</td><td style="text-align:center">ok</td></tr></table>').children[0];
    expect(table).toMatchObject({ type: 'table', align: [null, 'right', 'center'] });
  });

  it('states the alignment of every column a spanning cell covers', () => {
    const table = ir('<table><tr><th colspan="2" align="right">Totals</th><th>Note</th></tr>'
      + '<tr><td>1</td><td>2</td><td>x</td></tr></table>').children[0];
    expect(table).toMatchObject({ align: ['right', 'right', null] });
  });

  it('carries the alignment into the written table', () => {
    expect(mdx('<table><tr><th>N</th><th align="right">Qty</th></tr><tr><td>a</td><td align="right">1</td></tr></table>'))
      .toContain('| --- | ---: |');
  });

  it('writes no alignment when the source states none', () => {
    const table = ir('<table><tr><th>A</th></tr><tr><td>1</td></tr></table>').children[0];
    expect(table).not.toHaveProperty('align');
  });
});
