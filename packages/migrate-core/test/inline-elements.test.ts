/**
 * Inline elements a page carries as JSX, read as what they render instead of left as markers: a
 * link, a code span, a superscript, and Mintlify's inline components — a badge keeps its text, a
 * tooltip keeps its text and its tip, an icon is a glyph with no words and is the one thing dropped.
 * On a 1050-page site these were 384 markers in the output.
 */
import { describe, it, expect } from 'vitest';
import { markdownToIr } from '../src/ir/from-markdown.js';

const read = (body: string, platform = 'mintlify') => {
  const doc = markdownToIr(`---\ntitle: T\n---\n\n${body}\n`, { platform, file: 'p.mdx', pageId: 'p' });
  // the raw values of every inline node, so an HTML string is compared unescaped
  const values: string[] = [];
  const walk = (nodes: any[]): void => { for (const n of nodes) { if (typeof n.value === 'string') values.push(n.value); if (typeof n.url === 'string') values.push(`link:${n.url}`); if (Array.isArray(n.children)) walk(n.children); } };
  walk(doc.children);
  return { json: JSON.stringify(doc.children), values };
};

describe('inline elements', () => {
  it('reads a link, a code span and a superscript', () => {
    const { json, values } = read('See <a href="/x" title="X">the page</a>, run <code>mint dev</code>, note<sup>2</sup>.');
    expect(values).toContain('link:/x');
    expect(json).toContain('"type":"inlineCode","value":"mint dev"');
    expect(values).toContain('<sup>2</sup>');
    expect(json).not.toContain('UNSUPPORTED');
  });

  it('reads Mintlify\'s badge, tooltip and icon', () => {
    const { json, values } = read('Status <Badge>Beta</Badge> uses <Tooltip tip="Model Context Protocol">MCP</Tooltip> <Icon icon="check" /> today.');
    expect(values).toContain('<span className="dai-mig-badge">Beta</span>');
    expect(values).toContain('<abbr title="Model Context Protocol">MCP</abbr>');
    expect(json).not.toContain('Icon');
    expect(json).not.toContain('UNSUPPORTED');
  });

  it('leaves another platform\'s unknown components as markers for a person', () => {
    expect(read('A <Widget/> here.', 'generic').json).toContain('UNSUPPORTED INLINE COMPONENT Widget');
  });
});

describe('a link inside a link', () => {
  it('is written once, as the browser shows it', async () => {
    const { docToMdx } = await import('../src/ir/to-dai-mdx.js');
    const doc = markdownToIr('---\ntitle: T\n---\n\nWrite to <a href="mailto:support@example.com">[support@example.com](mailto:support@example.com)</a> today.\n', { platform: 'mintlify', file: 'p.mdx', pageId: 'p' });
    const mdx = docToMdx(doc);
    expect(mdx).toContain('Write to [support@example.com](mailto:support@example.com) today.');
    expect(mdx).not.toContain('[[');
  });
});
