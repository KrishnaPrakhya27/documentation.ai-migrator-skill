/**
 * The check of the rendered preview (human gate 4) fails a page only for what a reader would miss.
 *
 * On the first full-size run (1,046 pages of a real documentation site, migrated exactly) the old
 * check failed 509 routes, and not one of them was a fault in the migration: a language label the
 * platform draws over a code block ("jsonjson"), a "required" pill, an alt text shown as a caption,
 * request samples laid out beside the text, links the theme adds. A gate nobody can make pass stops
 * being read, and the customer it blocks raises a ticket about a site that is fine. These cases pin
 * what still fails, what is only noted, and how a named person accepts a finding.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { fetchRenderer, passagePresence, renderedPage, runBrowserContentGate, textSkeleton } from '../src/verify/browser.js';
import { acceptPreviewRoutes, readPreviewAcceptances } from '../src/verify/preview-acceptances.js';

const shown = (text: string) => renderedPage(text.toLowerCase());

describe('is a source passage on the rendered page', () => {
  it('finds a passage the platform respelled: an entity it left in inline code, backticks it drew as code', () => {
    // the platform's MDX preprocessor rewrites `{variable}` inside inline code to the literal text &#123;variable}
    expect(passagePresence('you can write {variable} directly', shown('…so you can write &#123;variable} directly without escaping'))).toBe('respelled');
    // a description's backticks are drawn as code formatting, not as characters
    expect(passagePresence('customize the agent with an `agents.md` file', shown('Customize the agent with an AGENTS.md file'))).toBe('respelled');
    expect(textSkeleton('a &#123;b} — “c”')).toBe('abc');
  });

  it('finds a code sample the platform rewrote in places, by the words around the rewrite', () => {
    // an example of a fence, shown inside a longer fence: the platform strips the options from its opening line
    const sample = '```mermaid placement="top-left" actions={true} flowchart lr a --> b ```';
    const body = 'flowchart lr a --> b ```';
    expect(passagePresence(sample, shown('show controls: ```mermaid flowchart lr a --> b ``` next'), { body })).toBe('altered');
    const long = 'const client = new client({ key: process.env.key }); const pets = await client.pets.list({ status: "available" }); console.log("first\\nsecond", pets.length);';
    expect(passagePresence(long, shown(long.replace('\\n', ' ')), {})).toBe('altered');
  });

  it('does not find a passage that is not there, whatever kind it is', () => {
    const page = shown('Install the CLI. Then run the command below.');
    expect(passagePresence('you must rotate the signing key every ninety days', page)).toBe('absent');
    expect(passagePresence('curl --request post https://api.example.com/v1/pets --header "authorization: bearer"', page, { body: '--header "authorization: bearer"' })).toBe('absent');
    // a long paragraph of which only the opening survives is lost, not altered
    const paragraph = 'Webhooks are signed with a secret that is shown once when the endpoint is created and cannot be read again afterwards, so store it before leaving the page.';
    expect(passagePresence(paragraph.toLowerCase(), shown('Webhooks are signed with a secret.'))).toBe('absent');
  });
});

describe('what the rendered-preview check fails, notes and accepts', () => {
  const doc = markdownToIr('---\ntitle: Keys\n---\n\nRotate the key every ninety days.\n\n```bash\ncurl https://api.example.com/v1/keys\n```\n', { platform: 'mintlify', file: 'keys.md', pageId: 'p' });
  const page = { id: 'p', newPath: 'keys', migrate: true, doc };
  const html = (body: string) => `<html><body><main><h1>Keys</h1>${body}</main></body></html>`;
  const whole = '<p>Rotate the key every ninety days.</p><pre>bash<code>curl https://api.example.com/v1/keys</code></pre>';

  it('passes a page that carries its source, noting the label the platform draws on the code block', async () => {
    const result = await runBrowserContentGate('https://preview.example/', [page], { render: async () => html(whole) });
    expect(result.gate.status).toBe('pass');
    expect(result.routes[0].problems).toEqual([]);
  });

  it('fails a page that lost a paragraph, and one that lost a code sample', async () => {
    const prose = await runBrowserContentGate('https://preview.example/', [page], { render: async () => html('<pre><code>curl https://api.example.com/v1/keys</code></pre>') });
    expect(prose.routes[0]).toMatchObject({ status: 'fail', problems: ['not on the rendered page: “rotate the key every ninety days.”'] });
    const code = await runBrowserContentGate('https://preview.example/', [page], { render: async () => html('<p>Rotate the key every ninety days.</p>') });
    expect(code.routes[0].status).toBe('fail');
    expect(code.gate.detail).toContain('dai-migrate accept --route');
  });

  it('does not ask the preview for a page no navigation entry names: that was decided, and reported, at nav', async () => {
    let requested = 0;
    const result = await runBrowserContentGate('https://preview.example/', [page], { unservedRoutes: new Set(['keys']), render: async () => { requested++; return html(''); } });
    expect(requested).toBe(0);
    expect(result.routes[0]).toMatchObject({ status: 'pass', problems: [] });
    expect(result.routes[0].advisories?.[0]).toContain('not served');
  });

  it('names a navigation link the platform draws with no destination, for whoever runs the platform', async () => {
    // a link-only dropdown item is written as the platform's schema states it; the renderer builds its address from a path it does not have
    const nav = '<nav><a href="/docs">Guides</a><a href="/null">Learn</a></nav>';
    const result = await runBrowserContentGate('https://preview.example/', [page], { render: async () => `<html><body>${nav}<main><h1>Keys</h1>${whole}</main></body></html>` });
    expect(result.gate.status).toBe('pass');
    const site = result.routes.find((route) => route.route === '(site)')!;
    expect(site.advisories?.[0]).toContain('1 navigation link(s) with no destination (/null): "learn"');
  });

  it('stops failing a route a named person reviewed and accepted, and keeps the finding and the name on the record', async () => {
    const accepted = new Map([['keys', { by: 'Asha Rao', reason: 'the sample moved into the API playground on purpose' }]]);
    const result = await runBrowserContentGate('https://preview.example/', [page], { accepted, render: async () => html('<p>Rotate the key every ninety days.</p>') });
    expect(result.gate.status).toBe('pass');
    expect(result.gate.detail).toContain('1 finding(s) reviewed and accepted by Asha Rao');
    expect(result.routes[0]).toMatchObject({ status: 'pass', accepted: accepted.get('keys') });
    expect(result.routes[0].problems).toHaveLength(1);
    // an acceptance of a route with nothing to accept changes nothing
    const clean = await runBrowserContentGate('https://preview.example/', [page], { accepted, render: async () => html(whole) });
    expect(clean.routes[0].accepted).toBeUndefined();
  });
});

describe('recording who accepted a preview finding', () => {
  it('keeps one decision per route, with the person and the reason, and ignores an entry that names neither', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dai-accept-'));
    mkdirSync(join(workspace, 'plan'));
    expect(readPreviewAcceptances(workspace)).toEqual([]);
    acceptPreviewRoutes(workspace, ['/docs/keys/'], 'first look', 'Asha Rao', '2026-09-17T00:00:00.000Z');
    acceptPreviewRoutes(workspace, ['docs/keys', 'docs/pets'], 'the platform rewrites this example', 'Asha Rao', '2026-09-17T01:00:00.000Z');
    expect(readPreviewAcceptances(workspace)).toEqual([
      { route: 'docs/keys', reason: 'the platform rewrites this example', by: 'Asha Rao', at: '2026-09-17T01:00:00.000Z' },
      { route: 'docs/pets', reason: 'the platform rewrites this example', by: 'Asha Rao', at: '2026-09-17T01:00:00.000Z' },
    ]);
    expect(readFileSync(join(workspace, 'plan', 'preview-acceptances.yaml'), 'utf8')).toContain('dai-migrate accept --route');
  });
});

describe('reading the preview over HTTP', () => {
  it('refuses an address inside the machine or its network, like every other request the migrator makes', async () => {
    await expect(fetchRenderer({ attempts: 1 })('http://127.0.0.1:9/docs')).rejects.toThrow(/non-public address|refused/);
    await expect(fetchRenderer({ attempts: 1 })('http://localhost:9/docs')).rejects.toThrow(/refused local host/);
  });
});
