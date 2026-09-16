/**
 * The customer report is the one artefact written for someone outside the team, and the half that
 * matters is what did *not* carry over. A migration that omits pages and reports only its successes
 * is worse than one that names them, because the customer finds out from a reader.
 *
 * So these tests are mostly about absence: every page the plan skipped, every block dropped, every
 * link still pointing at the old site and every check that did not pass has to reach the page, with
 * the reason recorded at the time — and a long list must say how much it is not showing.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCustomerReport, navigationSourceLanguage } from '../src/report/customer-data.js';
import { renderCustomerReportHtml } from '../src/report/customer-html.js';
import { GATE_LANGUAGE } from '../src/report/gate-language.js';
import { REQUIRED_RELEASE_GATE_IDS, type GateResult } from '../src/verify/gates.js';
import type { Session } from '../src/session/workspace.js';
import type { Tree, TreePage } from '../src/nav/tree.js';

const page = (id: string, extra: Partial<TreePage> = {}): TreePage => ({
  id, title: id, source: `${id}.md`, group: [], order: 0, oldPath: `/${id}`, migrate: true, reason: 'sidebar', ...extra,
});

const session = (extra: Partial<Session> = {}): Session => ({
  migrationId: 'mig-1', createdAt: '2026-09-15T00:00:00.000Z',
  source: { kind: 'url', location: 'https://docs.example.com', platform: 'gitbook' },
  target: { landing: 'customer-org', repoRemote: 'git@github.com:acme/docs.git', previewUrl: 'https://preview.example.com' },
  scope: 'full', customerAuthorisedCrawl: true, fidelityMode: 'exact',
  migrator: { gitSha: 'abc1234', dirty: false } as Session['migrator'],
  versions: { core: '0.1.0', contentContract: '1.4.0', parsers: {} },
  hashes: {}, stages: { write: { status: 'done', note: 'migration/mig-1' } },
  ...extra,
});

function workspace(build: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dai-customer-'));
  for (const sub of ['report', 'output', 'plan', 'quarantine']) mkdirSync(join(dir, sub), { recursive: true });
  build(dir);
  return dir;
}

const allPassing = (): GateResult[] => REQUIRED_RELEASE_GATE_IDS.map((id) => ({ id, status: 'pass' as const, detail: 'ok' }));

const build = (dir: string, tree: Partial<Tree>, gates: GateResult[], s = session()) =>
  buildCustomerReport({
    workspace: dir, session: s, gates, assets: 12, redirects: 4, generatedAt: '2026-09-15T10:00:00.000Z',
    tree: { scope: 'full', platform: 'gitbook', pages: [], ...tree },
  });

describe('what did not carry over', () => {
  it('names every skipped page, grouped by the reason recorded at the time', () => {
    const report = build(workspace(), {
      pages: [
        page('a'),
        page('draft-one', { migrate: false, reason: 'unpublished in the source' }),
        page('draft-two', { migrate: false, reason: 'unpublished in the source' }),
        page('orphan', { migrate: false, reason: 'not placed by the table of contents' }),
      ],
    }, allPassing());

    const headings = report.shortfalls.map((shortfall) => shortfall.heading);
    expect(headings).toContain('2 pages not migrated — unpublished in the source');
    expect(headings).toContain('1 page not migrated — not placed by the table of contents');
    // The pages themselves, not just a count: a customer cannot act on "2 pages".
    const unpublished = report.shortfalls.find((shortfall) => shortfall.heading.includes('unpublished'))!;
    expect(unpublished.items).toEqual(['draft-one — /draft-one', 'draft-two — /draft-two']);
    expect(unpublished.needsYou).toBe(true);
  });

  it('says how many it is not showing rather than truncating in silence', () => {
    const many = Array.from({ length: 230 }, (_, index) => page(`p${index}`, { migrate: false, reason: 'out of scope' }));
    const report = build(workspace(), { pages: many }, allPassing());
    const shortfall = report.shortfalls[0];
    expect(shortfall.items).toHaveLength(200);
    expect(shortfall.more).toBe(30);
    const html = renderCustomerReportHtml(report);
    expect(html).toContain('and 30 more');
    // the front page says it in one sentence, with names, and never lists addresses: those are in the appendix
    expect(shortfall.summary).toBe('230 pages were left out (recorded reason: out of scope). Tell us if any of them should be on the new site.');
    expect(shortfall.examples).toEqual(['p0', 'p1', 'p2']);
    expect(html.split('Appendix')[0]).not.toContain('/p0');
  });

  it('reports links still pointing at the old site as needing a decision', () => {
    const dir = workspace((w) => writeFileSync(join(w, 'report', 'unmigrated-links.json'), JSON.stringify([
      { route: 'guides/install', url: 'https://docs.example.com/legacy/setup', target: 'https://docs.example.com/legacy/setup', knownSourcePage: true },
    ])));
    const report = build(dir, { pages: [page('a')] }, allPassing());
    const links = report.shortfalls.find((shortfall) => shortfall.heading.includes('link'))!;
    expect(links.heading).toBe('1 link points at pages this migration does not include');
    expect(links.items[0]).toContain('/guides/install → https://docs.example.com/legacy/setup');
    expect(links.needsYou).toBe(true);
  });

  it('carries a failed check through with the gate\'s own words', () => {
    const gates = allPassing().map((gate) => gate.id === 'internal-links'
      ? { ...gate, status: 'fail' as const, detail: '3 links resolve to no written page', samples: ['/a → /missing'] }
      : gate);
    const report = build(workspace(), { pages: [page('a')] }, gates);
    const failed = report.shortfalls.find((shortfall) => shortfall.heading.includes('did not pass'))!;
    expect(failed.items[0]).toBe('Links between your pages resolve — 3 links resolve to no written page');
    expect(report.release.allowed).toBe(false);
  });

  it('states plainly that a permissive run proves nothing about fidelity', () => {
    const gates = allPassing().map((gate) => gate.id === 'source-content-exact'
      ? { ...gate, status: 'not-run' as const, detail: 'permissive mode; content fidelity is not certified' }
      : gate);
    const report = build(workspace(), { pages: [page('a')] }, gates, session({ fidelityMode: 'permissive' }));
    const notRun = report.shortfalls.find((shortfall) => shortfall.heading.includes('not run'))!;
    // Singular and plural both have to read as English: this is the customer's document.
    expect(notRun.heading).toBe('1 check was not run');
    expect(notRun.explanation).toContain('does not prove them either way');
    // A not-run check is never rendered as a pass.
    expect(report.checks.find((check) => check.id === 'source-content-exact')!.outcome).toBe('not-checked');
  });

  it('says so when nothing was left behind', () => {
    const report = build(workspace(), { pages: [page('a')], navigationSource: 'source-config' }, allPassing());
    expect(report.shortfalls).toEqual([]);
    expect(report.release.allowed).toBe(true);
    expect(renderCustomerReportHtml(report)).toContain('No decision is waiting on you');
  });
});

describe('the page a customer reads', () => {
  const full = () => build(workspace(), {
    pages: [page('a'), page('b'), page('gone', { migrate: false, reason: 'unpublished in the source' })],
    navigationSource: 'source-config',
  }, allPassing());

  it('leads with the verdict and the source of the sidebar', () => {
    const html = renderCustomerReportHtml(full());
    expect(html).toContain('passed every required check and is cleared for release');
    expect(html).toContain("your site&#x27;s own navigation file".replace('&#x27;', "'"));
  });

  it('speaks in the customer\'s terms, never in gate ids', () => {
    const gates = allPassing().map((gate) => (gate.id === 'code-blocks-exact' ? { ...gate, status: 'fail' as const, detail: '2 code blocks changed' } : gate));
    const html = renderCustomerReportHtml(build(workspace(), { pages: [page('a')] }, gates));
    expect(html).toContain('Code samples are character-for-character identical');
    expect(html).toContain('Checks at a glance');
    // The handles the team uses must not reach the customer's page.
    for (const id of ['source-content-exact', 'html-reconciliation', 'chrome-absent', 'deterministic-rerun']) {
      expect(html).not.toContain(id);
    }
  });

  it('escapes customer content rather than letting it become markup', () => {
    const report = build(workspace(), {
      pages: [page('x', { migrate: false, reason: '<script>alert(1)</script>' })],
    }, allPassing());
    const html = renderCustomerReportHtml(report);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('is a standalone document that fetches nothing', () => {
    const html = renderCustomerReportHtml(full());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // Printed offline and forwarded as a file: an external reference would render as a blank.
    expect(html).not.toMatch(/<(?:link|script)\b/);
    expect(html).not.toMatch(/https?:\/\/(?!docs\.example|preview\.example)/);
  });

  it('declares a paper size, since its only output is a printed page', () => {
    expect(renderCustomerReportHtml(full())).toContain('@page { size: A4;');
  });
});

describe('the gate vocabulary', () => {
  it('covers every gate that can block a release', () => {
    // A gate with no sentence falls back to its raw id, which is exactly what must not be shown.
    const missing = REQUIRED_RELEASE_GATE_IDS.filter((id) => !GATE_LANGUAGE[id]);
    expect(missing).toEqual([]);
  });

  it('describes inferred navigation as inferred', () => {
    expect(navigationSourceLanguage('url-path')).toContain('inferred');
    expect(navigationSourceLanguage('sitemap-hint')).toContain('inferred');
    expect(navigationSourceLanguage('source-config')).not.toContain('inferred');
    expect(navigationSourceLanguage(undefined)).toBeUndefined();
  });
});

describe('a report the customer can read without alarm', () => {
  it('prints no link targets or page addresses, only counts and plain sentences', () => {
    const dir = workspace((w) => {
      writeFileSync(join(w, 'report', 'unmigrated-links.json'), JSON.stringify([
        { route: 'guides/install', url: 'https://docs.example.com/legacy/setup', knownSourcePage: true },
        { route: 'guides/install', url: 'https://docs.example.com/legacy/other', knownSourcePage: true },
      ]));
      writeFileSync(join(w, 'plan', 'urls.yaml'), 'mode: preserve\nscope: full\nunmigratedLinks: source\npages: []\n');
    });
    const report = build(dir, { pages: [page('a')] }, allPassing());
    const links = report.shortfalls.find((shortfall) => shortfall.heading.includes('link'))!;
    // counted by the page that holds them, and not a decision once the old site is agreed to stay up
    expect(links.heading).toBe('1 page links to content outside this migration');
    expect(links.needsYou).toBe(false);
    expect(renderCustomerReportHtml(report).split('Appendix')[0]).not.toContain('docs.example.com/legacy');
  });

  it('says pages the old sidebar never listed were added to the sidebar when they were', () => {
    const dir = workspace((w) => writeFileSync(join(w, 'report', 'unlisted-pages.json'), JSON.stringify([{ title: 'Orphan', newPath: 'misc/orphan' }])));
    const report = build(dir, { pages: [page('a')], unlistedPlacement: { approvedBy: 'someone', approvedAt: '2026-09-16' } as never }, allPassing());
    const unlisted = report.shortfalls.find((shortfall) => shortfall.heading.includes('sidebar'))!;
    expect(unlisted.heading).toContain('now added to the sidebar');
    expect(unlisted.needsYou).toBe(false);
  });
});
