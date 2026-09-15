/**
 * `html-reconciliation` reads the rendered source and the written output side by side. The two
 * state the same page differently by design: a GitBook step opens with a heading that becomes a
 * Step's `title`, a card's cover is an `<img>` on the source and an `image` prop in the output, and
 * GitBook highlights code with utility classes that name no language while the published Markdown
 * names it on the fence. Reading those as disagreements failed 26 of 41 pages on the demo-64
 * migration with nothing lost. The check must still catch a heading, a picture or a code block that
 * actually went missing.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { htmlReconciliation, type RawSourcePage } from '../src/verify/source-truth.js';
import { getProfile } from '../src/scrape/profiles.js';

const profile = getProfile('gitbook')!;

function page(html: string, outputMdx: string): RawSourcePage {
  const workspace = mkdtempSync(join(tmpdir(), 'recon-'));
  const outputFile = join(workspace, 'page.mdx');
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, outputMdx);
  return { pageId: 'p1', path: 'page', route: 'page', url: 'https://demo-64.gitbook.io/demo-docs/page', outputFile, html, title: 'Page' } as RawSourcePage;
}

const STEPS_HTML = `<main><div class="page-document-item"><h2>Steps</h2><h4>Create your workspace</h4><p>Open the dashboard.</p><h4>Deploy</h4><p>Ship it.</p><h2>What's next?</h2></div></main>`;

describe('htmlReconciliation reads two spellings of one page', () => {
  it('counts a component title as the heading the source rendered', () => {
    const mdx = `## Steps\n\n<Steps>\n  <Step title="Create your workspace" titleType="h3">\n    Open the dashboard.\n  </Step>\n\n  <Step title="Deploy" titleType="h3">\n    Ship it.\n  </Step>\n</Steps>\n\n## What's next?\n`;
    expect(htmlReconciliation(page(STEPS_HTML, mdx), 'gitbook', profile).pass).toBe(true);
  });

  it('still fails when a heading the source rendered is nowhere in the output', () => {
    const mdx = `## Steps\n\n<Steps>\n  <Step title="Create your workspace" titleType="h3">\n    Open the dashboard.\n  </Step>\n</Steps>\n\n## What's next?\n`;
    expect(htmlReconciliation(page(STEPS_HTML, mdx), 'gitbook', profile).pass).toBe(false);
  });

  it('lets the output hold headings of its own, which the source states elsewhere', () => {
    const html = `<main><div class="page-document-item"><h2>Steps</h2><h4>Create your workspace</h4><p>Open the dashboard.</p></div></main>`;
    const mdx = `## Steps\n\n<Steps>\n  <Step title="Create your workspace" titleType="h3">\n    <Tabs>\n      <Tab title="Repository">Clone it.</Tab>\n    </Tabs>\n  </Step>\n</Steps>\n`;
    expect(htmlReconciliation(page(html, mdx), 'gitbook', profile).pass).toBe(true);
  });

  /**
   * A rendered page and the Markdown behind it hold different numbers of code blocks and images in
   * either direction with nothing lost: GitBook leaves an unopened tab's code out of the DOM, names
   * no language in its markup, renders an OpenAPI fence as samples the output states as ParamField
   * and ResponseField, and draws a linked repository's favicon inside an embed card the output keeps
   * as a link. `code-blocks-exact`, `source-content-exact` and `assets-ready` compare those against
   * the Markdown the source published, which is the authored witness.
   */
  it('does not count code blocks or images against the rendered page', () => {
    const html = `<main><div class="page-document-item"><h2>Install</h2><pre><code class="table w-fit">npm i</code></pre><pre><code>npm test</code></pre><img src="https://github.com/fluidicon.png" alt="" /></div></main>`;
    const mdx = '## Install\n\n```bash\nnpm i\n```\n';
    expect(htmlReconciliation(page(html, mdx), 'gitbook', profile).pass).toBe(true);
  });

  it('still fails when prose the rendered page states as a heading is nowhere in the output', () => {
    const html = `<main><div class="page-document-item"><h2>Install</h2><h2>Upgrade</h2></div></main>`;
    const mdx = '## Install\n';
    expect(htmlReconciliation(page(html, mdx), 'gitbook', profile).pass).toBe(false);
  });
});
