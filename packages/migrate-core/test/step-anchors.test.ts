import { describe, it, expect } from 'vitest';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { documentAnchors } from '../src/verify/fragments.js';
import { mintlifyHeadingId } from '../src/urls/slugger.js';
import { headingOutline, mdxHeadingOutline, mdxCodeBlocks, codeBlocks, proseSegments, normaliseMdxText, tableSignatures, mdxTableSignatures } from '../src/verify/gates.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';

describe('anchors the platform renders', () => {
  it('counts a Step title rendered as a heading, with the id Steps.tsx gives it', () => {
    const mdx = '---\ntitle: T\n---\n\n<Steps>\n  <Step title="Create a personal access token" titleType="h3">\n    Body.\n  </Step>\n  <Step title="Plain step">\n    Body.\n  </Step>\n</Steps>\n';
    const anchors = documentAnchors(markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' }), mdx);
    expect(anchors.has('create-a-personal-access-token')).toBe(true);
    expect(anchors.has('plain-step')).toBe(false);
  });
});

describe('Mintlify heading ids', () => {
  it('follow the renderer: dots and spaces to hyphens, badge text kept, some punctuation dropped', () => {
    expect(mintlifyHeadingId('llms-full.txt')).toBe('llms-full-txt');
    expect(mintlifyHeadingId('`navigation` - required')).toBe('navigation-required');
    expect(mintlifyHeadingId('Split indexes under `/_llms`')).toBe('split-indexes-under-/_llms');
    expect(mintlifyHeadingId('Automations, intégrations et Slack')).toBe('automations-intégrations-et-slack');
    expect(mintlifyHeadingId('Version majeure : collecte de feedback améliorée')).toBe('version-majeure--collecte-de-feedback-améliorée');
    expect(mintlifyHeadingId('Fix grammar & typos')).toBe('fix-grammar-&-typos');
    expect(mintlifyHeadingId('Default (*)')).toBe('default');
  });
});

describe('source and output normalise the same way', () => {
  it('pads a code span identically on both sides, inside parentheses and table cells', () => {
    const doc = markdownToIr('---\ntitle: T\n---\n\nSchemas (`oneOf` / `anyOf`) now expand. Rules (<hr />) hold.\n\n#### Content updated events (`spaceContentUpdated`)\n\n| Field | Description |\n| --- | --- |\n| `type` | Always `skill.md`. |\n', { platform: 'mintlify', file: 'p.mdx', pageId: 'p' });
    const mdx = docToMdx(doc);
    const hay = normaliseMdxText(mdx);
    for (const seg of proseSegments(doc)) expect(hay).toContain(seg);
    expect(headingOutline(doc)).toEqual(mdxHeadingOutline(mdx));
    expect(tableSignatures(doc)).toEqual(mdxTableSignatures(mdx));
  });
  it('keeps a heading badge in the outline the way the output shows it', () => {
    const doc = markdownToIr('---\ntitle: T\n---\n\n### `navigation` - <Badge color="red">required</Badge>\n\nText.\n', { platform: 'mintlify', file: 'p.mdx', pageId: 'p' });
    const mdx = docToMdx(doc);
    expect(mdxHeadingOutline(mdx)).toEqual(['3:navigation required']);
    expect(headingOutline(doc)).toEqual(mdxHeadingOutline(mdx));
  });
  it('sees a fence nested deep inside components', () => {
    const doc = markdownToIr('---\ntitle: T\n---\n\n<Steps>\n  <Step title="Install">\n    <Expandable title="CLI">\n      <CodeGroup>\n        ```bash npm\n        npm i -g mint\n        ```\n      </CodeGroup>\n    </Expandable>\n  </Step>\n</Steps>\n', { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    const mdx = docToMdx(doc);
    expect(codeBlocks(doc)).toEqual(['npm i -g mint']);
    expect(mdxCodeBlocks(mdx)).toEqual(['npm i -g mint']);
  });
});

describe('a prompt that became code', () => {
  it('is found in the code block under the spelling the code has, code spans unwrapped', async () => {
    const { proseSegmentsUnder } = await import('../src/verify/gates.js');
    const doc = markdownToIr('---\ntitle: T\n---\n\n<Prompt description="d">\n  使用 `npm i -g mint` 安装 CLI（如果我使用 pnpm，则使用 `pnpm add -g mint`）。\n</Prompt>\n', { platform: 'mintlify', file: 'p.mdx', pageId: 'p' });
    const prompt = doc.children[0];
    const pairs = proseSegmentsUnder(doc, new Set([prompt.id]));
    expect([...pairs.values()]).toEqual(['使用 npm i g mint 安装 cli（如果我使用 pnpm，则使用 pnpm add g mint）。']);
    const codeHay = normaliseMdxText('使用 npm i -g mint 安装 CLI（如果我使用 pnpm，则使用 pnpm add -g mint）。');
    for (const plain of pairs.values()) expect(codeHay).toContain(plain);
  });
});
