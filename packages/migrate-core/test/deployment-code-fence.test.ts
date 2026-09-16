import { describe, it, expect } from 'vitest';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import { validateMdx, deploymentFenceIssue, deploymentAttributeQuoteIssue } from '../../content-contract/src/index.js';

// gitbook.com/docs/create-content/formatting/markdown, as published
const SOURCE = '```` ```⏎ ```` creates a new code block.\n\n```` ```py⏎ ```` creates a new code block with Python syntax highlighting.\n\nAfter.';
const read = (body: string, platform: string) => markdownToIr(`---\ntitle: T\n---\n\n${body}\n`, { platform, file: 'p.md', pageId: 'p' });
const spans = (doc: ReturnType<typeof read>) => JSON.stringify(doc.children, (key, value) => (key === 'id' || key === 'src' ? undefined : value));

describe('a paragraph that opens with a code span showing a fence', () => {
  it('is what the deployment rejected: its line-based check reads the span as a nested fence', () => {
    expect(deploymentFenceIssue(`---\ntitle: T\n---\n\n${SOURCE}\n`)?.message).toMatch(/code fence with 4 backticks and an info string inside a 4-backtick code block/);
  });

  it('is written so no line starts with backticks, and reads back as the same inline code', () => {
    const doc = read(SOURCE, 'gitbook');
    const mdx = docToMdx(doc);
    expect(mdx.split('\n').filter((line) => /^\s*`{3,}/.test(line))).toEqual([]);
    expect(validateMdx(mdx).filter((issue) => issue.severity === 'error')).toEqual([]);
    const reread = read(mdx.replace(/^---[\s\S]*?---\n/, ''), 'dai');
    expect(spans(reread)).toBe(spans(doc));
    expect(JSON.stringify(doc.children)).toContain('"value":"```py⏎"');
  });

  it('leaves a real fenced code block, and a code span later in a line, exactly as they were', () => {
    const doc = read('Use `x` here.\n\n```js\nconst a = 1;\n```', 'gitbook');
    const mdx = docToMdx(doc);
    expect(mdx).toContain('Use `x` here.');
    expect(mdx).toMatch(/^```js$/m);
    expect(deploymentFenceIssue(mdx)).toBeUndefined();
  });
});

describe('an attribute value holding quote marks', () => {
  const image = (alt: string) => ({ pageId: 'p', platform: 'gitbook', source: 'p.md', frontmatter: { title: 'T' }, children: [{ id: 'i', type: 'image', url: 'https://cdn.example/a.png', alt }] } as any);
  const altBack = (mdx: string) => {
    const doc = markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    let alt: string | undefined;
    const walk = (nodes: any[]) => { for (const n of nodes) { if (n.type === 'image') alt = n.alt; if (Array.isArray(n.children)) walk(n.children); if (n.image) walk([n.image]); } };
    walk(doc.children);
    return alt;
  };

  it('is what the deployment rejected: &quot; inside a double-quoted attribute', () => {
    expect(deploymentAttributeQuoteIssue('<Expandable title="What does &quot;Page not found&quot; mean?">')?.message).toMatch(/double quote/);
  });

  for (const [label, alt] of [
    ['double quotes', 'A page titled "System Performance Monitoring."'],
    ['single quotes', "It's here"],
    ['both marks', `The "Agent" button's label`],
    ['both marks and braces', `Set "{API_KEY}" in the user's config`],
  ] as const) {
    it(`writes a value holding ${label} in a form the deployment accepts, and reads it back unchanged`, () => {
      const mdx = docToMdx(image(alt));
      expect(deploymentAttributeQuoteIssue(mdx)).toBeUndefined();
      expect(validateMdx(mdx).filter((issue) => issue.severity === 'error')).toEqual([]);
      expect(altBack(mdx)).toBe(alt);
    });
  }
});
