/**
 * HTML → PDF, through the Chrome this tool already requires.
 *
 * Verification drives Chrome over the DevTools Protocol, so printing costs no new dependency:
 * `Page.printToPDF` is the same connection with a different method. Adding Puppeteer to render one
 * page would pull a second browser download into a tool that already has one.
 *
 * The HTML is handed to the frame directly rather than navigated to, which removes both the temp
 * file and the wait for a load event — `Page.setDocumentContent` is a command, so awaiting it *is*
 * the synchronisation. Chrome is launched with name resolution stubbed out and script execution
 * disabled, so a report holding a customer's page titles has nothing to reach the network with.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from '../verify/browser.js';
import { connect, endpointFrom } from '../verify/chrome-session.js';

export class ChromeUnavailableError extends Error {}

/** Right margin matches the page's own 16mm, so the page number lines up with the text column. */
const FOOTER = '<div style="width:100%;font:7pt Helvetica,Arial,sans-serif;color:#5a6b7c;padding:0 16mm;text-align:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>';

/**
 * Renders `html` to a PDF at `outputPath`.
 *
 * Raises `ChromeUnavailableError` when no browser is installed, so the caller can keep the HTML it
 * already wrote and say how to finish the job, rather than losing the report over a missing binary.
 */
export async function htmlToPdf(html: string, outputPath: string): Promise<void> {
  const chromePath = findChrome();
  if (!chromePath) throw new ChromeUnavailableError('Chrome not found; set CHROME_PATH to a Chrome or Chromium binary');

  const profile = mkdtempSync(join(tmpdir(), 'dai-report-pdf-'));
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    '--disable-sync', '--no-first-run', `--user-data-dir=${profile}`,
    // Nothing in the report is fetched: the styles are inline and the content is the customer's.
    '--host-resolver-rules=MAP * ~NOTFOUND',
    '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let devtools: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    devtools = await connect(await endpointFrom(chrome));
    const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
    const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    await devtools.send('Page.enable', {}, sessionId);
    await devtools.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);

    const { frameTree } = await devtools.send('Page.getFrameTree', {}, sessionId) as { frameTree: { frame: { id: string } } };
    await devtools.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sessionId);

    const { data } = await devtools.send('Page.printToPDF', {
      // The page declares its own @page size and margins; Chrome must not impose a second set.
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: FOOTER,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    }, sessionId) as { data: string };

    writeFileSync(outputPath, Buffer.from(data, 'base64'), { mode: 0o600 });
  } finally {
    try { devtools?.close(); } catch { /* the connection is already gone */ }
    // Wait for the browser to be gone before removing its profile: killed while still writing to
    // it, the directory refills under the removal and `rmdir` reports it not empty — which once
    // turned a PDF that had already been written into "PDF rendering failed". The profile is
    // scratch either way, so a directory that will not go quietly is left for the OS, not raised.
    chrome.kill('SIGKILL');
    await new Promise<void>((resolve) => { if (chrome.exitCode !== null || chrome.signalCode !== null) resolve(); else { chrome.once('exit', () => resolve()); setTimeout(resolve, 2000).unref(); } });
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
}
