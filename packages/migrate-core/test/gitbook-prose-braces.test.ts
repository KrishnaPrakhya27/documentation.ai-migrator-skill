import { describe, it, expect } from 'vitest';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import { validateMdx } from '../../content-contract/src/index.js';
import { documentAnchors } from '../src/verify/fragments.js';
import { normaliseMdxText, proseSegments } from '../src/verify/gates.js';

const read = (body: string) => markdownToIr(`---\ntitle: T\n---\n\n${body}\n`, { platform: 'gitbook', file: 'p.md', pageId: 'p' });
const text = (doc: ReturnType<typeof read>) => JSON.stringify(doc.children);
const values = (doc: ReturnType<typeof read>): string[] => { const out: string[] = []; const walk = (nodes: any[]) => { for (const n of nodes) { if (typeof n.value === 'string') out.push(n.value); if (Array.isArray(n.children)) walk(n.children); } }; walk(doc.children); return out; };

describe('GitBook prose that MDX would misread', () => {
  it('keeps a brace in prose, a link label and a table cell as the author’s character', () => {
    const doc = read('* [{if} blocks](/docs/blocks/conditional-content.md) now support all block types.\n\nUse a `{% openapi %}` block or a literal \\`{% openapi %}\\` in text.\n\n<table><thead><tr><th>Type</th></tr></thead><tbody><tr><td><code>(response) => { … }</code></td></tr></tbody></table>');
    const json = text(doc);
    expect(json).toContain('{if} blocks');
    expect(json).toContain('`{% openapi %}`');
    expect(json).not.toContain('UNSUPPORTED');
    expect(json).not.toContain('mdxFlowExpression');
    const mdx = docToMdx(doc);
    expect(() => markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' })).not.toThrow();
    expect(validateMdx(mdx)).toEqual([]);
  });
  it('reads a paragraph that opens with import as prose, not as ESM', () => {
    const doc = read('**Control the embed from code:**\n\nimport { useGitBook } from "@gitbook/embed/react";\n\nThen call it.');
    expect(values(doc)).toContain('import { useGitBook } from "@gitbook/embed/react";');
    expect(text(doc)).not.toContain('mdxjsEsm');
    expect(doc.children.filter((b) => b.type === 'paragraph')).toHaveLength(3);
    // and the output must not hand the same line back to MDX as ESM
    const mdx = docToMdx(doc);
    expect(mdx).toContain('&#105;mport &#123; useGitBook &#125; from "@gitbook/embed/react";');
    expect(validateMdx(mdx)).toEqual([]);
    const again = markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    expect(values(again)).toContain('import { useGitBook } from "@gitbook/embed/react";');
    const hay = normaliseMdxText(mdx);
    for (const seg of proseSegments(doc)) expect(hay).toContain(seg);
  });
  it('leaves braces inside fences and code spans alone', () => {
    const doc = read('```js\nconst a = { b: 1 };\n```\n\nRun `{% hint %}` here.');
    expect(doc.children[0]).toMatchObject({ type: 'code', value: 'const a = { b: 1 };' });
    expect(text(doc)).toContain('"type":"inlineCode","value":"{% hint %}"');
  });
});

describe('GitBook tags the export never closes', () => {
  it('reads {% file %} inside a step without waiting for a closing tag', () => {
    const doc = read('{% stepper %}\n{% step %}\n### Download\n\n{% file src="/files/abc" %}\n{% endstep %}\n{% endstepper %}');
    const json = text(doc);
    expect(json).toContain('"name":"file"');
    expect(json).toContain('"src":"/files/abc"');
  });
  it('joins what the export left after an autolinked embed URL back onto the address', () => {
    const doc = read('{% embed url="<https://www.youtube.com/embed/hCd2_AAHU_I?si=jm2VOThMVh7NdJm>\\_" %}\n\n{% embed url="<https://youtu.be/sbDvxsQB5ls>?" %}');
    const json = text(doc);
    expect(json).toContain('"src":"https://www.youtube.com/embed/hCd2_AAHU_I?si=jm2VOThMVh7NdJm_"');
    expect(json).toContain('"src":"https://youtu.be/sbDvxsQB5ls?"');
  });
});

describe('GFM footnotes', () => {
  const body = 'Here is a footnote[^1], and a longer one[^bignote].\n\n[^1]: This is the first footnote.\n\n[^bignote]: Here is one with two paragraphs.\n\n    And the second paragraph.\n';
  it('round-trip through the IR and the serializer unchanged', () => {
    const doc = read(body);
    expect(text(doc)).toContain('"type":"footnoteReference","identifier":"1"');
    expect(doc.children.filter((b) => b.type === 'footnoteDefinition')).toHaveLength(2);
    const mdx = docToMdx(doc);
    expect(mdx).toContain('footnote[^1], and a longer one[^bignote].');
    expect(mdx).toContain('[^1]: This is the first footnote.');
    expect(mdx).toContain('[^bignote]: Here is one with two paragraphs.\n\n    And the second paragraph.');
    expect(validateMdx(mdx)).toEqual([]);
    const again = markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    expect(again.children.filter((b) => b.type === 'footnoteDefinition')).toHaveLength(2);
  });
  it('are anchors the platform renders and marks the prose comparison ignores', () => {
    const doc = read(body);
    const mdx = docToMdx(doc);
    const anchors = documentAnchors(markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' }), mdx);
    expect(anchors.has('user-content-fn-1')).toBe(true);
    expect(anchors.has('user-content-fnref-bignote')).toBe(true);
    const hay = normaliseMdxText(mdx);
    for (const seg of proseSegments(doc)) expect(hay).toContain(seg);
  });
});

describe('code the escaper must not touch', () => {
  it('keeps a ```` fence that quotes ``` inside it as one block, and escapes the prose after it', () => {
    const doc = read('````markdown\n```js\nconst a = { b: 1 };\n```\n````\n\nAfter the block, {if} is prose.\n\nA ``span with ` inside`` and `{x}` stay code.');
    expect(doc.children[0]).toMatchObject({ type: 'code', value: '```js\nconst a = { b: 1 };\n```' });
    expect(values(doc)).toContain('After the block, {if} is prose.');
    expect(values(doc)).toContain('span with ` inside');
    expect(values(doc)).toContain('{x}');
  });
  it('reads the required marker in an exported HTML table cell as the character', () => {
    const doc = read('<table><thead><tr><th>Parameter</th><th>Type</th></tr></thead><tbody><tr><td><code>clientId</code>*</td><td><code>string</code></td></tr><tr><td><code>clientSecret</code>*</td><td>text</td></tr></tbody></table>');
    expect(doc.children[0].type).toBe('table');
    expect(values(doc)).toContain('*');
    expect(text(doc)).not.toContain('emphasis');
  });
});

describe('GitBook search and assistant buttons', () => {
  it('are chrome inline and as a block', () => {
    const doc = read('Open search: <button type="button" class="button primary" data-action="search" data-query="Inline buttons">Search for "Inline buttons"</button> now.\n\n<button type="button" class="button primary" data-action="search" data-icon="magnifying-glass">Search...</button>\n');
    expect(values(doc)).toContain('Open search: ');
    expect(text(doc)).not.toContain('UNSUPPORTED');
    const block = doc.children[1];
    expect(block).toMatchObject({ type: 'component', name: 'button', props: { 'data-action': 'search' } });
  });
});
