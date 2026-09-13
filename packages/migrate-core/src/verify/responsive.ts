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

/**
 * Measures every route at every viewport and fails on a page that scrolls sideways or renders no
 * text at all. Readings are returned for the report whether or not the gate passes, so an operator
 * can see the widths rather than only the verdict.
 */
export async function runResponsiveGate(
  routes: ReadonlyArray<{ route: string; url: string }>,
  session: Pick<ChromeSession, 'measure'>,
  viewports: readonly Viewport[] = VIEWPORTS,
  concurrency = 4,
): Promise<{ gate: GateResult; readings: ResponsiveReading[] }> {
  if (!routes.length) {
    return { gate: { id: 'responsive-layout', status: 'not-run', detail: 'no preview routes to measure' }, readings: [] };
  }
  const readings: ResponsiveReading[] = [];
  const problems: string[] = [];
  // Deterministic order: sorted routes, then viewports narrowest first, so two runs of the same
  // preview produce the same report.
  const ordered = [...routes].sort((a, b) => a.route.localeCompare(b.route));
  const jobs = [...viewports].sort((a, b) => a.width - b.width).flatMap((viewport) => ordered.map(({ route, url }) => ({ viewport, route, url })));
  const measured = await mapConcurrentOrdered(jobs, concurrency, async ({ viewport, route, url }) => {
    try {
      const measurement = JSON.parse(await session.measure<string>(url, MEASURE, { viewport: { width: viewport.width, height: viewport.height } })) as Measurement;
      return { viewport, route, measurement } as const;
    } catch (error) {
      return { viewport, route, error: (error as Error).message } as const;
    }
  });
  for (const result of measured) {
      const { viewport, route } = result;
      if ('error' in result) { problems.push(`${route} at ${viewport.name}: ${result.error}`); continue; }
      const { measurement } = result;
      readings.push({ route, viewport: viewport.name, overflowing: measurement.overflowing, scrollWidth: measurement.scrollWidth, width: measurement.viewport, text: measurement.text, wide: measurement.wide });
      // A page that declares no `width=device-width` is laid out by a phone at a desktop width and
      // then shrunk to fit, which is why such a page arrives unreadably small on a real device.
      if (measurement.viewport > viewport.width + 4) {
        problems.push(`${route} at ${viewport.name}: the page declares no mobile viewport, so it is laid out at ${measurement.viewport}px on a ${viewport.width}px screen`);
        continue;
      }
      if (measurement.overflowing) problems.push(`${route} at ${viewport.name} (${viewport.width}px): the page scrolls sideways to ${measurement.scrollWidth}px${measurement.wide.length ? `, widened by ${measurement.wide.join(', ')}` : ''}`);
      if (!measurement.text) problems.push(`${route} at ${viewport.name}: the page rendered no text`);
  }
  return {
    gate: {
      id: 'responsive-layout',
      status: problems.length ? 'fail' : 'pass',
      detail: problems.length
        ? `${problems.length} layout problem(s) across ${ordered.length} page(s) at ${viewports.length} viewports`
        : `${ordered.length} page(s) fit ${viewports.map((viewport) => `${viewport.name} (${viewport.width}px)`).join(', ')} without scrolling sideways`,
      count: problems.length,
      samples: problems.slice(0, 6),
    },
    readings,
  };
}
