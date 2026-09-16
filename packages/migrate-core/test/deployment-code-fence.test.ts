import { describe, it, expect } from 'vitest';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import { validateMdx, deploymentFenceIssue } from '../../content-contract/src/index.js';

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
