/**
 * Documentation is read on phones. A page whose table pushes the layout sideways passes every
 * content check there is and still looks broken to the customer's readers, so the migrated pages
 * are measured at the three shapes people actually use.
 */
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { runResponsiveGate, VIEWPORTS } from '../src/verify/responsive.js';
import { openChromeSession } from '../src/verify/chrome-session.js';
import { findChrome } from '../src/verify/browser.js';

const reading = (over: Partial<{ viewport: number; scrollWidth: number; overflowing: boolean; text: number; wide: string[] }> = {}): string =>
  JSON.stringify({ viewport: 390, scrollWidth: 390, overflowing: false, text: 120, wide: [], ...over });

describe('measuring the migrated pages', () => {
  it('keeps the browser pool busy while preserving deterministic report order', async () => {
    let active = 0; let peak = 0;
    const { readings } = await runResponsiveGate(
      [{ route: 'b', url: 'b' }, { route: 'a', url: 'a' }],
      { measure: async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((resume) => setTimeout(resume, 10));
        active--;
        return reading() as never;
      } },
      VIEWPORTS.slice(0, 2),
      3,
    );
    expect(peak).toBe(3);
    expect(readings.map((item) => `${item.viewport}:${item.route}`)).toEqual(['mobile:a', 'mobile:b', 'tablet:a', 'tablet:b']);
  });

  it('passes pages that fit every viewport, and says which viewports were measured', async () => {
    const { gate, readings } = await runResponsiveGate(
      [{ route: 'b', url: 'https://preview.test/b' }, { route: 'a', url: 'https://preview.test/a' }],
      { measure: async () => reading() as never },
    );
    expect(gate).toMatchObject({ id: 'responsive-layout', status: 'pass', count: 0 });
    expect(gate.detail).toContain('mobile (390px)');
    // deterministic: routes sorted, viewports narrowest first, so two runs report identically
    expect(readings.map((r) => `${r.viewport}:${r.route}`)).toEqual([
      'mobile:a', 'mobile:b', 'tablet:a', 'tablet:b', 'desktop:a', 'desktop:b',
    ]);
  });

  it('fails a page that scrolls sideways, naming the viewport and what widened it', async () => {
    const { gate } = await runResponsiveGate(
      [{ route: 'wide', url: 'https://preview.test/wide' }],
      { measure: async (_url, _expression, options) => (options?.viewport?.width === 390
        ? reading({ overflowing: true, scrollWidth: 900, wide: ['table.pricing'] })
        : reading({ viewport: options?.viewport?.width ?? 1440, scrollWidth: options?.viewport?.width ?? 1440 })) as never },
    );
    expect(gate.status).toBe('fail');
    expect(gate.samples?.[0]).toContain('wide at mobile (390px)');
    expect(gate.samples?.[0]).toContain('table.pricing');
  });

  it('fails a page that renders no text, and reports a page it could not measure', async () => {
    const blank = await runResponsiveGate([{ route: 'a', url: 'u' }], { measure: async () => reading({ text: 0 }) as never }, [VIEWPORTS[0]]);
    expect(blank.gate.samples?.[0]).toContain('rendered no text');
    const broken = await runResponsiveGate([{ route: 'a', url: 'u' }], { measure: async () => { throw new Error('navigation timed out'); } }, [VIEWPORTS[0]]);
    expect(broken.gate).toMatchObject({ status: 'fail' });
    expect(broken.gate.samples?.[0]).toContain('navigation timed out');
  });

  it('reports rather than passes when there is nothing to measure', async () => {
    expect((await runResponsiveGate([], { measure: async () => '' as never })).gate.status).toBe('not-run');
  });
});

const chrome = findChrome();
describe.skipIf(!chrome)('measured in a real browser', () => {
  const listen = async (pages: Record<string, string>): Promise<{ base: string; server: Server }> => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(pages[request.url ?? ''] ?? '<html><body>missing</body></html>');
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
  };

  it('catches a page that spills off a phone while the same content fits a desktop', async () => {
    process.env.DAI_ALLOW_LOCAL_PREVIEW = '1';
    const meta = '<meta name="viewport" content="width=device-width, initial-scale=1">';
    const wide = `<html><head>${meta}</head><body style="margin:0"><div style="width:900px">Far too wide for a phone</div></body></html>`;
    const fits = `<html><head>${meta}</head><body style="margin:0"><p>Comfortable on any screen.</p></body></html>`;
    // a page that declares no mobile viewport is laid out at a desktop width on a phone
    const noMeta = '<html><body style="margin:0"><p>No viewport declared.</p></body></html>';
    const { base, server } = await listen({ '/wide': wide, '/fits': fits, '/no-meta': noMeta });
    const session = await openChromeSession(`${base}/fits`, { concurrency: 2 });
    try {
      const onPhone = await runResponsiveGate([{ route: 'wide', url: `${base}/wide` }], session, [VIEWPORTS[0]]);
      expect(onPhone.gate.status).toBe('fail');
      expect(onPhone.gate.samples?.[0]).toContain('scrolls sideways');
      const onDesktop = await runResponsiveGate([{ route: 'wide', url: `${base}/wide` }], session, [VIEWPORTS[2]]);
      expect(onDesktop.gate.status).toBe('pass');
      const everywhere = await runResponsiveGate([{ route: 'fits', url: `${base}/fits` }], session);
      expect(everywhere.gate.status).toBe('pass');
      expect(everywhere.readings).toHaveLength(3);
      const undeclared = await runResponsiveGate([{ route: 'no-meta', url: `${base}/no-meta` }], session, [VIEWPORTS[0]]);
      expect(undeclared.gate.status).toBe('fail');
      expect(undeclared.gate.samples?.[0]).toContain('declares no mobile viewport');
    } finally {
      await session.close();
      server.close();
    }
  }, 120_000);
});
