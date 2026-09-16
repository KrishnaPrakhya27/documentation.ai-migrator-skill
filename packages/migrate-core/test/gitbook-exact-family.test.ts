/**
 * What the first exact-mode run on gitbook.com surfaced, each proven in the smallest form.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRawSourcePages, sourceMetadataExact } from '../src/verify/source-truth.js';
import { acquiredPath } from '../src/scrape/acquire.js';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import { authoredContentSnapshot, renderedDocSnapshot, fidelityEqual, firstFidelityDifference } from '../src/verify/fidelity.js';
import { gitbookHtmlBlockToIr } from '../src/ir/gitbook-html.js';
import { redirectProblems } from '../src/urls/redirect-graph.js';
import { mergeNavigationTrees, type DiscoveredNavigationNode } from '../src/scrape/discovery.js';

const gb = (body: string) => markdownToIr(`---\ntitle: T\n---\n\n${body}\n`, { platform: 'gitbook', file: 'p.md', pageId: 'p' });
const dai = (mdx: string) => markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' });

describe('GitBook heading anchors', () => {
  it('take the id the export states, and drop the zero-width space and the empty anchor', () => {
    const doc = gb('## ​Prerequisites for SSO with GitBook <a href="#prerequisites-for-sso-with-gitbook" id="prerequisites-for-sso-with-gitbook"></a>\n\nText.\n\n### ​Set up on the IdP <a href="#setup-on-the-idp" id="setup-on-the-idp"></a>');
    const [h2, , h3] = doc.children;
    expect(h2).toMatchObject({ type: 'heading', depth: 2, sourceId: 'prerequisites-for-sso-with-gitbook', children: [{ type: 'text', value: 'Prerequisites for SSO with GitBook' }] });
    expect(h3).toMatchObject({ type: 'heading', depth: 3, sourceId: 'setup-on-the-idp', children: [{ type: 'text', value: 'Set up on the IdP' }] });
    expect(docToMdx(doc)).not.toContain('​');
  });
});

describe('what the written file reads back as', () => {
  it('a figure: the caption rides on the Image and comes back as the figure it was', () => {
    const doc = gb('<figure><img src="https://x.test/a.png" alt="A"><figcaption><p>The import panel.</p></figcaption></figure>');
    expect(doc.children[0]).toMatchObject({ type: 'figure', caption: [{ type: 'text', value: 'The import panel.' }] });
    const mdx = docToMdx(doc);
    expect(mdx).toContain('caption="The import panel."');
    expect(mdx).not.toContain('*The import panel.*');
    expect(firstFidelityDifference(authoredContentSnapshot(doc), authoredContentSnapshot(dai(mdx)))).toBeUndefined();
  });
  it('a titled fence with no language: written as text, read as the same block', () => {
    const doc = gb('{% code title="Your site’s default URL" %}\n\n```\nhttps://[org].gitbook.io/[site]\n```\n\n{% endcode %}');
    const mdx = docToMdx(doc);
    expect(mdx).toContain('```text title="Your site’s default URL"');
    expect(fidelityEqual(renderedDocSnapshot(doc), renderedDocSnapshot(dai(mdx)))).toBe(true);
  });
  it('an inline element alone on its line is still the paragraph it was', () => {
    const doc = gb('<mark>This text is orange.</mark>');
    const mdx = docToMdx(doc);
    const again = dai(mdx);
    expect(again.children[0]).toMatchObject({ type: 'paragraph', children: [{ type: 'inlineHtml', value: '<mark>This text is orange.</mark>' }] });
    expect(fidelityEqual(authoredContentSnapshot(doc), authoredContentSnapshot(again))).toBe(true);
  });
});

describe('fidelity folds', () => {
  it('a step whose first line is a bold heading folds that heading into the title', () => {
    const src = gb('{% stepper %}\n{% step %}\n### **Create or open your site**\n\nOpen the site.\n{% endstep %}\n{% endstepper %}');
    const resolved = { ...src, children: [{ ...src.children[0], children: [{ ...(src.children[0] as any).children[0], props: { title: 'Create or open your site' }, children: (src.children[0] as any).children[0].children.slice(1) }] }] } as typeof src;
    expect(firstFidelityDifference(authoredContentSnapshot(src), authoredContentSnapshot(resolved))).toBeUndefined();
  });
  it('a bare address and a link showing that address, percent-encoded, are one text', () => {
    const text = gb('https://files.test/o/diff%20view.mp4?alt=media&token=abc?autoplay=1');
    // what a rule leaves behind: the address decoded on the link, the label as the author wrote it
    const linked = { ...text, children: [{ ...text.children[0], children: [{ id: 'l', type: 'link' as const, url: 'https://files.test/o/diff view.mp4?alt=media&token=abc?autoplay=1', title: '', children: [{ id: 't', type: 'text' as const, value: 'https://files.test/o/diff%20view.mp4?alt=media&token=abc?autoplay=1' }] }] }] } as typeof text;
    expect(firstFidelityDifference(authoredContentSnapshot(text), authoredContentSnapshot(linked))).toBeUndefined();
  });
});

describe('GitBook cards', () => {
  it('title from the heading, blurb as the body, not one run-on title', () => {
    const html = '<table data-view="cards"><thead><tr><th></th><th></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><h4><i class="fa-wand">:wand:</i></h4></td><td><h4>How to make a great-looking docs site</h4><p>Build a polished visual experience.</p></td><td><a href="/docs/guides/a.md">How to</a></td></tr></tbody></table>';
    const [cards] = gitbookHtmlBlockToIr(html, 'p');
    const card = (cards as any).children[0];
    expect(card.props.title).toBe('How to make a great-looking docs site');
    expect(JSON.stringify(card.children)).toContain('Build a polished visual experience.');
  });
});

describe('redirect wildcards', () => {
  it('do not shadow an exact rule they agree with', () => {
    const exact = [{ source: '/docs/a/x', destination: '/en/docs/a/x', statusCode: 308 }, { source: '/docs/a/y', destination: '/other', statusCode: 308 }];
    const wildcard = [{ source: '/docs/a/*', destination: '/en/docs/a/:splat', statusCode: 308 }];
    const problems = redirectProblems([...exact, ...wildcard], new Set(['en/docs/a/x', 'other']));
    expect(problems.filter((p) => p.kind === 'shadowed').map((p) => p.detail)).toEqual([expect.stringContaining('/docs/a/y')]);
  });
});

describe('section sidebars merge in address order', () => {
  it('give one tree whichever order the pages arrive in', () => {
    const page = (url: string, title: string): DiscoveredNavigationNode => ({ type: 'page', url, title });
    const a: DiscoveredNavigationNode[] = [{ type: 'group', label: 'Help', children: [page('https://x/help/a', 'A')] }, { type: 'group', label: 'Guides', children: [page('https://x/guides/a', 'GA')] }];
    const b: DiscoveredNavigationNode[] = [{ type: 'group', label: 'Help', children: [page('https://x/help/a', 'A')] }, { type: 'group', label: '2026', children: [page('https://x/changelog', 'C')] }];
    expect(mergeNavigationTrees(a, b).map((n) => (n as any).label)).toEqual(['Help', 'Guides', '2026']);
  });
});

describe('GitBook emoji shortcodes', () => {
  it('become the character the site renders, inside and outside headings, and never inside an identifier', () => {
    const doc = gb('### :boom: Breaking changes\n\nA :frame\\_photo: here, a scope `site:metadata:read`, and site:metadata:read in prose. Unknown :notanemoji: stays.');
    const text = JSON.stringify(doc.children);
    expect(text).toContain('💥 Breaking changes');
    expect(text).toContain('A 🖼️ here');
    expect(text).toContain('site:metadata:read in prose');
    expect(text).toContain(':notanemoji: stays');
  });
});

describe('titles the source escapes', () => {
  it('read as their characters from llms.txt and from a published H1', async () => {
    const { parseLlmsIndex, unwrapPublishedMarkdown } = await import('../src/scrape/published-markdown.js');
    const index = parseLlmsIndex('# Site\n\n- [Guide \\[updated for 2026\\]](https://x.test/docs/guide.md): A guide\n', 'https://x.test/llms.txt');
    expect(index.entries[0].title).toBe('Guide [updated for 2026]');
    expect(unwrapPublishedMarkdown('# Guide \\[updated for 2026]\n\nBody.\n', 'gitbook').title).toBe('Guide [updated for 2026]');
  });

  it('reads a frozen record\'s escaped llms.txt title as the text it labels', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dai-escaped-title-'));
    const outputDir = join(workspace, 'output');
    mkdirSync(join(workspace, 'source-cache', 'acquired'), { recursive: true });
    mkdirSync(join(outputDir, 'docs'), { recursive: true });
    const escaped = 'Guide \\[updated for 2026\\]';
    writeFileSync(acquiredPath(workspace, 'p1'), JSON.stringify({
      url: 'https://x.test/docs/guide', finalUrl: 'https://x.test/docs/guide', contentType: 'text/markdown',
      title: escaped, markdown: '# Guide \\[updated for 2026\\]\n\nBody.\n',
      llms: { title: escaped, mdUrl: 'https://x.test/docs/guide.md' },
    }));
    writeFileSync(join(outputDir, 'docs', 'guide.mdx'), '---\ntitle: "Guide [updated for 2026]"\n---\n\nBody.\n');
    const [page] = loadRawSourcePages({ workspace, outputDir, pages: [{ id: 'p1', migrate: true, newPath: 'docs/guide', source: 'https://x.test/docs/guide', title: escaped }] });
    expect(page.title).toBe('Guide [updated for 2026]');
    expect(page.llms?.title).toBe('Guide [updated for 2026]');
    expect(sourceMetadataExact(page, 'gitbook').pass).toBe(true);
  });

  it('writes a text run that opens with an asterisk once-escaped, so it reads back as the asterisk', () => {
    const doc = { pageId: 'p', frontmatter: { title: 'p' }, children: [{ id: 'l', type: 'list', ordered: false, children: [{ id: 'i', type: 'listItem', children: [{ id: 'q', type: 'paragraph', children: [
      { id: 'e', type: 'emphasis', children: [{ id: 'et', type: 'text', value: 'Avoid it.' }] },
      { id: 't', type: 'text', value: '* That collapses the nav.' },
    ] }] }] }] } as any;
    const mdx = docToMdx(doc);
    expect(mdx).not.toContain('\\\\*');
    const back = markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    const para = ((back.children[0] as any).children[0].children[0]) as any;
    expect(para.children.map((n: any) => (n.type === 'text' ? n.value : n.type))).toEqual(['emphasis', '* That collapses the nav.']);
  });
});
