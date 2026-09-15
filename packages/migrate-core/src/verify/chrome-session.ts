/**
 * One browser for a whole verification run.
 *
 * Every rendered check launched its own Chrome: a fresh process, a fresh profile directory and a
 * fresh startup for each URL. On a 448-page migration that is roughly nine hundred launches, and
 * the two rendered gates each paid for their own copy of the same page. Startup dominated the run,
 * and nothing could ever be asked of a page twice — which is why no check could expand an
 * accordion, open a tab or measure a second viewport.
 *
 * This keeps one Chrome and a bounded set of pages inside it, driven over the DevTools protocol
 * with the WebSocket the runtime already provides, so no browser-automation dependency is added.
 * The safety properties of the single-shot launcher are kept exactly: the preview host is resolved
 * and pinned, every other hostname is made unresolvable so a redirect fails closed, and the profile
 * lives in a temporary directory that is removed at the end.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPublicHost } from '../scrape/fetcher.js';
import { findChrome, pinnedResolverRules } from './browser.js';

export interface RenderOptions {
  /** Page size to render at, for checks that depend on layout. */
  viewport?: { width: number; height: number };
  /** Script evaluated in the page before the DOM is read, for expanding what the reader can open. */
  prepare?: string;
  timeoutMs?: number;
}

export interface ChromeSession {
  render: (url: string, options?: RenderOptions) => Promise<string>;
  /** Evaluates an expression in the loaded page and returns its value: what a layout check needs and a DOM dump cannot give. */
  measure: <T>(url: string, expression: string, options?: RenderOptions) => Promise<T>;
  close: () => Promise<void>;
}

interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }

const DEFAULT_TIMEOUT_MS = 45_000;
const LAUNCH_TIMEOUT_MS = 30_000;

/** Chrome prints the endpoint it is listening on to stderr; there is no other way to learn the port. */
function endpointFrom(chrome: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not report a DevTools endpoint within ${LAUNCH_TIMEOUT_MS}ms`)), LAUNCH_TIMEOUT_MS);
    const done = (error?: Error, endpoint?: string): void => {
      clearTimeout(timer);
      chrome.stderr?.off('data', onData);
      if (error) reject(error); else resolve(endpoint!);
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /ws:\/\/[^\s]+/.exec(output);
      if (match) done(undefined, match[0]);
    };
    chrome.stderr?.on('data', onData);
    chrome.once('exit', (code) => done(new Error(`Chrome exited with code ${code} before listening: ${output.slice(-400)}`)));
  });
}

/** A DevTools connection with request/response correlation by command id. */
function connect(endpoint: string): Promise<{
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const pending = new Map<number, Pending>();
    let nextId = 1;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; sessionId?: string; result?: Record<string, unknown>; error?: { message: string } };
      if (message.id !== undefined) {
        const waiting = pending.get(message.id);
        pending.delete(message.id);
        if (!waiting) return;
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result ?? {});
        return;
      }
    });
    socket.addEventListener('error', () => reject(new Error('DevTools connection failed')));
    socket.addEventListener('close', () => {
      for (const waiting of pending.values()) waiting.reject(new Error('DevTools connection closed'));
      pending.clear();
    });
    socket.addEventListener('open', () => resolve({
      send: (method, params = {}, sessionId) => new Promise((resolveSend, rejectSend) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveSend, reject: rejectSend });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      close: () => socket.close(),
    }));
  });
}

/**
 * Opens what a reader can open, before the DOM is read.
 *
 * A static render shows a collapsed accordion as a closed box and an unselected tab as nothing at
 * all, so content the customer wrote was excused from verification rather than checked. Opening
 * everything first means that content is compared like the rest. Clicks are wrapped because a
 * control that refuses to be clicked must not stop the render.
 */
export const EXPAND_INTERACTIVE = `new Promise((done) => {
  const click = (element) => { try { element.click(); } catch (error) { /* the content gate reports a control that will not open */ } };
  const settle = () => new Promise((ready) => {
    let timer;
    const finish = () => { observer.disconnect(); clearTimeout(timer); ready(); };
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, 100); });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(finish, 100);
    setTimeout(finish, 2000);
  });
  const collapsed = () => Array.from(document.querySelectorAll('[aria-expanded="false"]:not([role="tab"])'));
  /**
   * A server-rendered accordion is in the DOM before its framework attaches the handler that opens
   * it, and a click that lands first does nothing at all. Clicking once and reading the DOM made
   * this gate a race: the same preview reported 6 routes differing on one run and 8 on the next,
   * always the bodies of collapsed blocks. Clicking is retried until nothing opens any more, so the
   * run waits for the page to become interactive rather than hoping it already is.
   */
  const openAll = async () => {
    // A handler that has not attached yet is indistinguishable from one that will never attach, so
    // clicking is retried against a deadline rather than stopped the first time nothing happens.
    // A control still closed at the deadline is reported by the content gate, which knows whether
    // anything the author wrote was behind it.
    const deadline = Date.now() + 4000;
    while (true) {
      const remaining = collapsed();
      if (!remaining.length) return true;
      remaining.forEach(click);
      await settle();
      if (!collapsed().length) return true;
      if (Date.now() > deadline) return false;
      await new Promise((ready) => setTimeout(ready, 150));
    }
  };
  (async () => {
    if (document.readyState !== 'complete') await new Promise((ready) => window.addEventListener('load', ready, { once: true }));
    document.querySelectorAll('details').forEach((element) => { element.open = true; });
    await openAll();
    document.querySelectorAll('details').forEach((element) => { element.open = true; });
    await settle();
    // A tab UI exposes one panel at a time. Preserve the DOM of every selected state in tab order,
    // then replace the live panels with those inert clones so verification sees all authored states.
    for (const list of Array.from(document.querySelectorAll('[role="tablist"]'))) {
      const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
      const captured = [];
      for (const tab of tabs) {
        click(tab);
        await settle();
        const controlled = tab.getAttribute('aria-controls');
        const panel = controlled ? document.getElementById(controlled) : Array.from(document.querySelectorAll('[role="tabpanel"]')).find((candidate) => !candidate.hidden && candidate.getAttribute('aria-hidden') !== 'true');
        if (!panel) continue;
        const clone = panel.cloneNode(true);
        clone.hidden = false;
        clone.removeAttribute('aria-hidden');
        clone.removeAttribute('style');
        captured.push(clone);
      }
      if (captured.length) {
        const host = document.createElement('div');
        host.setAttribute('data-dai-tab-panels', 'expanded');
        captured.forEach((panel) => host.appendChild(panel));
        const ids = new Set(tabs.map((tab) => tab.getAttribute('aria-controls')).filter(Boolean));
        document.querySelectorAll('[role="tabpanel"]').forEach((panel) => { if (!panel.closest('[data-dai-tab-panels]') && (!panel.id || ids.has(panel.id))) panel.remove(); });
        list.after(host);
      }
    }
    await settle();
    done(true);
  })().catch(() => done(false));
})`;

/**
 * One render per URL for a whole run. The fragment gate and the content gate ask for the same
 * pages, and each used to fetch and render its own copy of every one of them.
 */
export function cachedRenderer(render: (url: string, options?: RenderOptions) => Promise<string>, options: RenderOptions = {}): (url: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (url) => {
    const existing = cache.get(url);
    if (existing) return existing;
    const rendering = render(url, options);
    cache.set(url, rendering);
    // A failed render must not be remembered as the answer for the rest of the run.
    rendering.catch(() => cache.delete(url));
    return rendering;
  };
}

/**
 * Opens a browser for this preview and returns a renderer over a bounded set of pages. Renders are
 * handed to whichever page is free; a page renders one URL at a time, so each has one navigation
 * in flight and results cannot interleave.
 */
export async function openChromeSession(previewUrl: string, options: { concurrency?: number } = {}): Promise<ChromeSession> {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH to a Chrome or Chromium binary');
  const parsed = new URL(previewUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('preview URL must use HTTP or HTTPS');
  const localPreview = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  const resolverRules = localPreview && process.env.DAI_ALLOW_LOCAL_PREVIEW === '1'
    ? undefined
    : pinnedResolverRules(parsed.hostname, await assertPublicHost(parsed));

  const profile = mkdtempSync(join(tmpdir(), 'dai-chrome-profile-'));
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    '--disable-sync', '--no-first-run', `--user-data-dir=${profile}`,
    ...(resolverRules ? [`--host-resolver-rules=${resolverRules}`] : []),
    '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let devtools: Awaited<ReturnType<typeof connect>> | undefined;
  const shutdown = async (): Promise<void> => {
    try { devtools?.close(); } catch { /* the connection is already gone */ }
    chrome.kill('SIGKILL');
    // The kill returns before Chrome has finished writing its profile, so a removal that starts at
    // once races it and throws ENOTEMPTY - which failed a whole preview verification after every
    // gate had already run. The retries wait for the process to let go, and a profile that still
    // will not go is a temporary directory the system reclaims, never a reason to lose the result.
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the system to reclaim */ }
  };

  try {
    devtools = await connect(await endpointFrom(chrome));
    const count = Math.max(1, Math.min(options.concurrency ?? 4, 8));
    const pages = await Promise.all(Array.from({ length: count }, async () => {
      const { targetId } = await devtools!.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
      const { sessionId } = await devtools!.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
      await devtools!.send('Page.enable', {}, sessionId);
      return { sessionId, busy: false };
    }));

    const queue: Array<() => void> = [];
    const takePage = async (): Promise<typeof pages[number]> => {
      const free = pages.find((page) => !page.busy);
      if (free) { free.busy = true; return free; }
      await new Promise<void>((resume) => queue.push(resume));
      return takePage();
    };
    const releasePage = (page: typeof pages[number]): void => { page.busy = false; queue.shift()?.(); };

    const onPage = async <T>(url: string, renderOptions: RenderOptions, read: string): Promise<T> => {
        const timeoutMs = renderOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const page = await takePage();
        try {
          if (renderOptions.viewport) {
            await devtools!.send('Emulation.setDeviceMetricsOverride', { ...renderOptions.viewport, deviceScaleFactor: 1, mobile: renderOptions.viewport.width < 600 }, page.sessionId);
          } else await devtools!.send('Emulation.clearDeviceMetricsOverride', {}, page.sessionId);
          const navigation = await devtools!.send('Page.navigate', { url }, page.sessionId) as { errorText?: string };
          if (navigation.errorText) throw new Error(`${url}: ${navigation.errorText}`);
          // A prior implementation listened for the next load event. The about:blank reset from the
          // previous job could satisfy that listener, causing this job to inspect a blank or partial
          // document. Poll the document in this target instead; redirects are allowed, blank is not.
          const deadline = Date.now() + timeoutMs;
          let ready = false;
          while (Date.now() < deadline) {
            try {
              const state = await devtools!.send('Runtime.evaluate', { expression: `location.href !== 'about:blank' && document.readyState === 'complete'`, returnByValue: true }, page.sessionId) as { result?: { value?: unknown } };
              if (state.result?.value === true) { ready = true; break; }
            } catch { /* the execution context is replaced while navigation commits */ }
            await new Promise<void>((resume) => setTimeout(resume, 25));
          }
          if (!ready) throw new Error(`${url}: timed out after ${timeoutMs}ms waiting for the document to become ready`);
          if (renderOptions.prepare) {
            const prepared = await devtools!.send('Runtime.evaluate', { expression: renderOptions.prepare, awaitPromise: true, returnByValue: true }, page.sessionId) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };
            if (prepared.exceptionDetails || prepared.result?.value !== true) throw new Error(`${url}: interactive content could not be expanded`);
          }
          const result = await devtools!.send('Runtime.evaluate', { expression: read, returnByValue: true, awaitPromise: true }, page.sessionId) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };
          if (result.exceptionDetails) throw new Error(`${url}: ${result.exceptionDetails.text}`);
          if (result.result?.value === undefined) throw new Error(`${url}: the page returned nothing to read`);
          return result.result.value as T;
        } finally {
          // Leave the page on a blank document so the next render cannot read the last one.
          try { await devtools!.send('Page.navigate', { url: 'about:blank' }, page.sessionId); } catch { /* the browser is going away */ }
          releasePage(page);
        }
    };

    return {
      render: (url, renderOptions = {}) => onPage<string>(url, renderOptions, 'document.documentElement.outerHTML'),
      measure: <T>(url: string, expression: string, renderOptions: RenderOptions = {}) => onPage<T>(url, renderOptions, expression),
      close: shutdown,
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}
