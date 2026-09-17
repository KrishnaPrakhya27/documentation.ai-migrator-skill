/**
 * The migrated page on a phone, a tablet and a desktop.
 *
 * Rendered verification read one DOM at whatever width headless Chrome happened to use, so a page
 * that reads fine on a laptop and spills off the side of a phone passed. Documentation is read on
 * phones, and a table or a code block pushing the page sideways is the most common way a migration
 * looks broken to the customer's readers while every content check passes.
 *
 * What is measured is the layout, not the pixels: whether the page scrolls sideways, and which
 * elements are wider than the screen. Screenshot comparison is deliberately avoided — it differs
 * between font sets and browser versions, so it reports failures that are not failures.
 */
import type { GateResult } from './gates.js';
import type { ChromeSession } from './chrome-session.js';
import { mapConcurrentOrdered } from './concurrency.js';

export interface Viewport { name: string; width: number; height: number }

/** The three shapes a documentation reader actually uses. */
export const VIEWPORTS: Viewport[] = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

/**
 * Runs in the page. A few pixels of overflow are rounding, not a broken layout, and an element
 * inside its own horizontally scrolling container is a table or a code block behaving correctly.
 */
/**
 * Layout is measured once the page has stopped moving, not merely once the document is complete.
 * The target hydrates and then loads its images, so a measurement taken at `readyState` complete
 * caught a different set of images each run: the same deployment reported 335 problems once and
 * 197 the next time, which is a number no one can act on. Waits for the fonts and every image the
 * page has, then for two consecutive animation frames with the same layout width.
 */
export const SETTLE = `(async () => {
  const deadline = Date.now() + 8000;
  try { await document.fonts.ready; } catch { /* fonts are not required to settle the layout */ }
  const images = [...document.images].filter((image) => !image.complete);
  await Promise.all(images.map((image) => new Promise((done) => {
    const stop = () => { image.removeEventListener('load', stop); image.removeEventListener('error', stop); done(); };
    image.addEventListener('load', stop); image.addEventListener('error', stop);
    setTimeout(stop, Math.max(0, deadline - Date.now()));
  })));
  // A headless page that is never painted may not run an animation frame at all, so every frame
  // also has a timer behind it: this waits for the layout to settle, it never waits forever.
  const frame = () => new Promise((paint) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; paint(document.documentElement.scrollWidth); };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
  let last = await frame();
  while (Date.now() < deadline) {
    const next = await frame();
    if (next === last) return true;
    last = next;
  }
  return true;
})()`;

const MEASURE = `(() => {
  const tolerance = 4;
  const viewport = document.documentElement.clientWidth;
  const scrollable = (element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
    return false;
  };
  const wide = [];
  for (const element of document.querySelectorAll('body *')) {
    const box = element.getBoundingClientRect();
    if (box.width <= viewport + tolerance && box.right <= viewport + tolerance) continue;
    if (scrollable(element)) continue;
    if (getComputedStyle(element).position === 'fixed') continue;
    const name = element.tagName.toLowerCase() + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\\s+/)[0] : '');
    if (!wide.includes(name)) wide.push(name);
    if (wide.length >= 5) break;
  }
  return JSON.stringify({
    viewport,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: document.documentElement.scrollWidth > viewport + tolerance,
    text: (document.body.innerText || '').trim().length,
    wide,
  });
})()`;

export interface ResponsiveReading {
  route: string;
  viewport: string;
  overflowing: boolean;
  scrollWidth: number;
  width: number;
  text: number;
  wide: string[];
}

interface Measurement { viewport: number; scrollWidth: number; overflowing: boolean; text: number; wide: string[] }

/** How many pages the layout is measured on unless every page is asked for. */
export const RESPONSIVE_SAMPLE = 24;

/**
 * A spread of routes to measure: the first (the site's home) and then evenly through the rest, in
 * the site's own order, so every section contributes. Layout is the theme's, and a theme lays a
 * page out the same way whichever page it is; what differs is the content on it (a wide table, a
 * large picture), and a spread across sections meets each kind. The same routes every run.
 */
export function sampleRoutes<T>(routes: readonly T[], size = RESPONSIVE_SAMPLE): T[] {
  if (size <= 0 || routes.length <= size) return [...routes];
  const picked = new Set<number>([0]);
  for (let index = 1; index < size; index++) picked.add(Math.round((index * (routes.length - 1)) / (size - 1)));
  return [...picked].sort((a, b) => a - b).map((index) => routes[index]);
}

/**
 * Measures routes at every viewport. A page that renders no text at some width fails: a reader on
 * that device gets nothing. A page that scrolls sideways is noted with what widened it, never
 * failed: everything on it is there and readable, and the width of a picture or a table on a phone
 * is the theme's to decide (a rule in the site's custom stylesheet changes it), not something a
 * migration of the content can make pass. Readings are returned for the report either way.
 */
export async function runResponsiveGate(
  routes: ReadonlyArray<{ route: string; url: string }>,
  session: Pick<ChromeSession, 'measure'>,
  viewports: readonly Viewport[] = VIEWPORTS,
  concurrency = 4,
  /** How many routes the site has, when `routes` is a sample of them. */
  outOf?: number,
): Promise<{ gate: GateResult; readings: ResponsiveReading[] }> {
  if (!routes.length) {
    return { gate: { id: 'responsive-layout', status: 'not-run', detail: 'no preview routes to measure' }, readings: [] };
  }
  const readings: ResponsiveReading[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  // Deterministic order: sorted routes, then viewports narrowest first, so two runs of the same
  // preview produce the same report.
  const ordered = [...routes].sort((a, b) => a.route.localeCompare(b.route));
  const jobs = [...viewports].sort((a, b) => a.width - b.width).flatMap((viewport) => ordered.map(({ route, url }) => ({ viewport, route, url })));
  const measured = await mapConcurrentOrdered(jobs, concurrency, async ({ viewport, route, url }) => {
    try {
      const measurement = JSON.parse(await session.measure<string>(url, MEASURE, { viewport: { width: viewport.width, height: viewport.height }, prepare: SETTLE })) as Measurement;
      return { viewport, route, measurement } as const;
    } catch (error) {
      return { viewport, route, error: (error as Error).message } as const;
    }
  });
  for (const result of measured) {
      const { viewport, route } = result;
      // a measurement that could not be taken says nothing about the page: the content gate has already loaded it
      if ('error' in result) { notes.push(`${route} at ${viewport.name}: not measured (${result.error})`); continue; }
      const { measurement } = result;
      readings.push({ route, viewport: viewport.name, overflowing: measurement.overflowing, scrollWidth: measurement.scrollWidth, width: measurement.viewport, text: measurement.text, wide: measurement.wide });
      // A page that declares no `width=device-width` is laid out by a phone at a desktop width and
      // then shrunk to fit, which is why such a page arrives unreadably small on a real device.
      if (measurement.viewport > viewport.width + 4) {
        notes.push(`${route} at ${viewport.name}: the page declares no mobile viewport, so it is laid out at ${measurement.viewport}px on a ${viewport.width}px screen`);
        continue;
      }
      if (measurement.overflowing) notes.push(`${route} at ${viewport.name} (${viewport.width}px): the page scrolls sideways to ${measurement.scrollWidth}px${measurement.wide.length ? `, widened by ${measurement.wide.join(', ')}` : ''}`);
      if (!measurement.text) problems.push(`${route} at ${viewport.name}: the page rendered no text`);
  }
  const measured_ = outOf && outOf > ordered.length ? `${ordered.length} of ${outOf} page(s), spread across the site,` : `${ordered.length} page(s)`;
  const widths = viewports.map((viewport) => `${viewport.name} (${viewport.width}px)`).join(', ');
  return {
    gate: {
      id: 'responsive-layout',
      status: problems.length ? 'fail' : 'pass',
      detail: problems.length
        ? `${problems.length} page(s) render no text at some screen width, of ${measured_} measured at ${widths}`
        : `${measured_} render their text at ${widths}${notes.length ? `; ${notes.length} reading(s) scroll sideways or were not taken (report/responsive.json)` : ' without scrolling sideways'}`,
      count: problems.length,
      samples: problems.slice(0, 6),
      ...(notes.length ? { advisories: notes.length, advisorySamples: notes.slice(0, 6) } : {}),
    },
    readings,
  };
}
