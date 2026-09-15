/**
 * A rendered page states its title in a heading, but not every generator uses `<h1>` for it: a
 * MadCap Flare topic keeps `<h1>` for the skin masthead and opens the article at `<h2>`. Reading
 * only `<h1>` therefore finds no title on a page that plainly states one, and exact mode stops.
 */
import { describe, it, expect } from 'vitest';
import { titleHeading } from '../src/ir/page-title.js';
import type { Block } from '../src/ir/types.js';

const heading = (depth: number, value: string): Block => ({ id: `h${depth}-${value}`, type: 'heading', depth, children: [{ id: `t-${value}`, type: 'text', value }] } as unknown as Block);
const paragraph = (value: string): Block => ({ id: `p-${value}`, type: 'paragraph', children: [{ id: `pt-${value}`, type: 'text', value }] } as unknown as Block);
const text = (block: Block | undefined): string | undefined => (block as { children?: Array<{ value?: string }> } | undefined)?.children?.[0]?.value;

describe('the heading that states a page title', () => {
  it('is the H1 when the article has one', () => {
    expect(text(titleHeading([heading(1, 'Page'), paragraph('body'), heading(2, 'Section')]))).toBe('Page');
  });

  it('is the opening heading when the article reserves H1 for the masthead', () => {
    expect(text(titleHeading([heading(2, 'Convert audience to SQL'), paragraph('body'), heading(3, 'Step')]))).toBe('Convert audience to SQL');
  });

  it('prefers an H1 further down over the opening heading, as before', () => {
    expect(text(titleHeading([heading(2, 'Opening'), heading(1, 'The real title')]))).toBe('The real title');
  });

  it('is nothing when a heading only appears after content: a section is not a page title', () => {
    expect(titleHeading([paragraph('lead paragraph'), heading(2, 'Section')])).toBeUndefined();
  });

  it('is nothing when the article states no heading at all', () => {
    expect(titleHeading([paragraph('body only')])).toBeUndefined();
    expect(titleHeading([])).toBeUndefined();
  });
});
