/**
 * Two spellings that are valid MDX but break Documentation.AI's renderer: fence meta it compiles as
 * `<pre>` props (a bare `className` became `className={true}`, and the code block's
 * `className.match` answered 500), and a `<` inside a quoted attribute value, which its preprocessor
 * reads as a tag and then mangles the expression after it on the same line.
 */
import { describe, it, expect } from 'vitest';
import { docToMdx, fenceMeta } from '../src/ir/to-dai-mdx.js';
import { markdownToIr } from '../src/ir/from-markdown.js';

const roundTrip = (markdown: string) => {
  const ir = markdownToIr(markdown, { platform: 'dai', file: 'f', pageId: 'p' });
  const written = docToMdx(ir);
  return { ir, written, back: markdownToIr(written, { platform: 'dai', file: 'f', pageId: 'p' }) };
};

describe('MDX the platform can compile and render', () => {
  it('keeps plain fence meta as written and carries unsafe meta whole in one quoted prop', () => {
    expect(fenceMeta('Steps example')).toBe('Steps example');
    expect(fenceMeta('className example')).toBe('meta="className example"');
    expect(fenceMeta('Write class names in full')).toBe('meta="Write class names in full"');
    expect(fenceMeta('Example (with parens)')).toBe('meta="Example (with parens)"');
    expect(fenceMeta('title={x}')).toBe('meta="title=&amp;#123;x&amp;#125;"');
    expect(fenceMeta('title="a b" wrap lines')).toBe('title="a b" wrap lines');
    // linear: a long word before a character no attribute can take once hung conversion
    const started = Date.now();
    expect(fenceMeta(`${'a'.repeat(5000)}(`)).toMatch(/^meta="/);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('reads the quoted meta back to the exact text it carried', () => {
    for (const meta of ['className example', 'a "quoted" <tag> {expr} & more']) {
      const { written, back } = roundTrip(`\`\`\`mdx ${meta}\ncode\n\`\`\`\n`);
      expect(written).toContain('meta="');
      const code = back.children.find((block) => block.type === 'code');
      expect(code && code.type === 'code' ? code.meta : undefined).toBe(meta);
    }
  });

  it('writes < and > in an attribute value as references that read back as the same text', () => {
    const { written, back } = roundTrip('<ResponseField name="children" type="ReactElement<StepProps>[]" required={true}>\n  A list.\n</ResponseField>\n');
    expect(written).toContain('type="ReactElement&lt;StepProps&gt;[]"');
    expect(written).not.toMatch(/="[^"]*<[^"]*"/);
    const field = back.children.find((block) => block.type === 'dai' || block.type === 'component') as { props: Record<string, unknown> } | undefined;
    expect(field?.props.type).toBe('ReactElement<StepProps>[]');
  });
});
