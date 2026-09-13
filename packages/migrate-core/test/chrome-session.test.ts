/**
 * Rendered verification launched a whole Chrome per URL, and each gate rendered the same page
 * again for itself. One browser with a bounded set of pages, and one render per route shared by
 * both gates, is what makes a rendered check affordable on a real migration — and what makes it
 * possible to open an accordion before reading the page, which a one-shot DOM dump never could.
 */
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { cachedRenderer, openChromeSession, EXPAND_INTERACTIVE } from '../src/verify/chrome-session.js';
import { findChrome } from '../src/verify/browser.js';

describe('one render per route', () => {
  it('renders each URL once and shares it with every caller', async () => {
    const calls: string[] = [];
    const render = cachedRenderer(async (url) => { calls.push(url); return `<html>${url}</html>`; });
    const [a, b, c] = await Promise.all([render('/a'), render('/b'), render('/a')]);
    expect(calls).toEqual(['/a', '/b']);
    expect(a).toBe(c);
    expect(b).toContain('/b');
    await render('/a');
    expect(calls).toEqual(['/a', '/b']);
  });

  it('does not remember a failed render as the answer', async () => {
    let attempt = 0;
    const render = cachedRenderer(async () => { attempt++; if (attempt === 1) throw new Error('flaky'); return 'second'; });
    await expect(render('/a')).rejects.toThrow('flaky');
    expect(await render('/a')).toBe('second');
  });

  it('passes the render options every call shares', async () => {
    const seen: unknown[] = [];
    const render = cachedRenderer(async (_url, options) => { seen.push(options); return ''; }, { viewport: { width: 390, height: 844 } });
    await render('/a');
    expect(seen).toEqual([{ viewport: { width: 390, height: 844 } }]);
  });
});

const chrome = findChrome();
describe.skipIf(!chrome)('a real browser, driven over the DevTools protocol', () => {
  const listen = async (pages: Record<string, string>): Promise<{ base: string; server: Server }> => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(pages[request.url ?? ''] ?? '<html><body>missing</body></html>');
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
  };

  it('renders many routes through one browser without leaking one page into another', async () => {
    process.env.DAI_ALLOW_LOCAL_PREVIEW = '1';
    const { base, server } = await listen({
      '/a': '<html><body><h1>Alpha</h1></body></html>',
      '/b': '<html><body><h1>Beta</h1><script>document.body.insertAdjacentHTML("beforeend","<p>from script</p>")</script></body></html>',
    });
    const session = await openChromeSession(`${base}/a`, { concurrency: 2 });
    try {
      const urls = ['/a', '/b', '/a', '/b'].map((path) => base + path);
      const rendered = await Promise.all(urls.map((url) => session.render(url)));
      expect(rendered[0]).toContain('Alpha');
      expect(rendered[0]).not.toContain('Beta');
      // a DOM, not a document: content the page wrote after load is present
      expect(rendered[1]).toContain('from script');
      expect(rendered[2]).toContain('Alpha');
    } finally {
      await session.close();
      server.close();
    }
  }, 120_000);

  it('opens what a reader can open before the DOM is read', async () => {
    process.env.DAI_ALLOW_LOCAL_PREVIEW = '1';
    const { base, server } = await listen({
      '/x': '<html><body><details><summary>More</summary><p>Content behind the accordion</p></details>'
        + '<button aria-expanded="false" onclick="this.setAttribute(\'aria-expanded\',\'true\');document.getElementById(\'panel\').hidden=false">Show</button>'
        + '<div id="panel" hidden><p>Content behind the button</p></div></body></html>',
    });
    const session = await openChromeSession(`${base}/x`, { concurrency: 1 });
    try {
      const plain = await session.render(`${base}/x`);
      expect(/<details(?!\s+open)/.test(plain)).toBe(true);
      expect(plain).toContain('hidden');
      const opened = await session.render(`${base}/x`, { prepare: EXPAND_INTERACTIVE });
      expect(/<details[^>]*\sopen/.test(opened)).toBe(true);
      expect(opened).toContain('aria-expanded="true"');
    } finally {
      await session.close();
      server.close();
    }
  }, 120_000);

  it('captures every tab panel instead of only the final selected state', async () => {
    process.env.DAI_ALLOW_LOCAL_PREVIEW = '1';
    const tabs = `<html><body><div role="tablist">
      <button role="tab" aria-controls="one" onclick="select('one')">One</button>
      <button role="tab" aria-controls="two" onclick="select('two')">Two</button>
    </div><div id="one" role="tabpanel">First panel content</div><div id="two" role="tabpanel" hidden>Second panel content</div>
    <script>function select(id){document.querySelectorAll('[role=tabpanel]').forEach(p=>p.hidden=p.id!==id)}</script></body></html>`;
    const { base, server } = await listen({ '/tabs': tabs });
    const session = await openChromeSession(`${base}/tabs`, { concurrency: 1 });
    try {
      const opened = await session.render(`${base}/tabs`, { prepare: EXPAND_INTERACTIVE });
      expect(opened).toContain('First panel content');
      expect(opened).toContain('Second panel content');
      expect(opened.match(/data-dai-tab-panels/g)).toHaveLength(1);
    } finally {
      await session.close();
      server.close();
    }
  }, 120_000);

  it('refuses a preview URL that is not HTTP', async () => {
    await expect(openChromeSession('file:///etc/passwd')).rejects.toThrow(/HTTP or HTTPS/);
  });
});
