/**
 * The customer report as a printable page.
 *
 * One self-contained HTML file: no external stylesheet, font or script, because it is printed to
 * PDF by a headless browser with no network and is often forwarded as a standalone file afterwards.
 *
 * The layout is built for paper. Colour carries no meaning on its own — every outcome is also a
 * word — because these get printed in black and white and forwarded to people who never saw the
 * original. Each shortfall is a count and one plain sentence; page addresses and link targets are
 * not printed — a wall of URLs reads as alarm, not information. The full lists stay in
 * customer-report.json, and the page says they are available.
 */
import type { CustomerReport, CustomerCheck, Shortfall } from './customer-data.js';
import { GATE_GROUP_ORDER, GATE_GROUP_TITLES } from './gate-language.js';

/** Platform ids are internal handles; a customer document spells the product's own name. */
const PLATFORM_NAMES: Record<string, string> = {
  gitbook: 'GitBook', mintlify: 'Mintlify', readme: 'ReadMe', document360: 'Document360',
  docusaurus: 'Docusaurus', nextra: 'Nextra', fern: 'Fern', madcap: 'MadCap Flare',
  readthedocs: 'Read the Docs', generic: 'its previous platform',
};

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const OUTCOME_WORD: Record<CustomerCheck['outcome'], string> = {
  verified: 'Verified',
  failed: 'Not met',
  'not-checked': 'Not checked',
  'not-applicable': 'N/A',
};

function checkRow(check: CustomerCheck): string {
  const needsDetail = check.outcome !== 'verified';
  return `<tr class="r-${check.outcome}">
      <td class="o"><span class="tag t-${check.outcome}">${OUTCOME_WORD[check.outcome]}</span></td>
      <td>
        <div class="ct">${escape(check.title)}</div>
        ${needsDetail ? `<div class="cd">${escape(check.detail)}</div>` : ''}
      </td>
    </tr>`;
}

/** A shortfall as the front page states it: one sentence, a few names, no addresses. */
function frontLine(shortfall: Shortfall, withExamples = true): string {
  const examples = withExamples && shortfall.examples.length ? ` <span class="eg">For example: ${shortfall.examples.map(escape).join('; ')}.</span>` : '';
  const sentence = !withExamples && shortfall.readerSummary ? shortfall.readerSummary : shortfall.summary;
  return `<li><span class="lead">${escape(sentence)}</span>${examples}</li>`;
}

/** The same shortfall in the appendix: the full list, for whoever acts on it. */
function appendixBlock(shortfall: Shortfall, index: number): string {
  return `<section class="sf">
      <h3>A${index + 1}. ${escape(shortfall.heading)}</h3>
      <p>${escape(shortfall.explanation)}</p>
      ${shortfall.items.length ? `<ul class="items">${shortfall.items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : '<p class="more">No individual items to list.</p>'}
      ${shortfall.more ? `<p class="more">…and ${shortfall.more} more, listed in full in the accompanying data file.</p>` : ''}
    </section>`;
}

/** What the checks found, in five lines: the reader sees where things stand without reading forty rows. */
function checksAtAGlance(checks: CustomerCheck[]): string {
  const rows = GATE_GROUP_ORDER.map((group) => {
    const mine = checks.filter((check) => check.group === group);
    if (!mine.length) return '';
    const met = mine.filter((check) => check.outcome === 'verified' || check.outcome === 'not-applicable').length;
    const open = mine.filter((check) => check.outcome === 'failed' || check.outcome === 'not-checked');
    const state = open.length ? (open.some((check) => check.outcome === 'failed') ? 'Attention' : 'Pending') : 'All good';
    const cls = open.length ? (open.some((check) => check.outcome === 'failed') ? 'failed' : 'not-checked') : 'verified';
    return `<tr class="r-${cls}">
        <td class="o"><span class="tag t-${cls}">${state}</span></td>
        <td><div class="ct">${escape(GATE_GROUP_TITLES[group])} <span class="score">${met} of ${mine.length} checks passed</span></div>
        ${open.length ? `<ul class="cs">${open.map((check) => `<li>${escape(check.title)} — ${check.outcome === 'failed' ? 'not yet' : 'not run yet'}</li>`).join('')}</ul>` : ''}</td>
      </tr>`;
  });
  return `<table class="checks">${rows.join('')}</table>`;
}

/** Every check that did not pass, with the run's own words, for the team that resolves it. */
function checksAppendix(checks: CustomerCheck[]): string {
  const open = checks.filter((check) => check.outcome === 'failed' || check.outcome === 'not-checked');
  if (!open.length) return '';
  return `<section class="sf">
      <h3>B. Checks not yet passed, in the run's own words</h3>
      <p>Technical detail for the people resolving them. A customer need not read this section.</p>
      <table class="checks">${open.map(checkRow).join('')}</table>
    </section>`;
}

const row = (label: string, value?: string): string =>
  value ? `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>` : '';

/**
 * `summary` writes the version for a reader rather than for the people acting on it: the verdict,
 * the numbers, each decision and note as one plain sentence, and the checks at a glance - with no
 * appendix, no page or link addresses and no technical detail. Nothing is dropped from the counts;
 * the itemised lists stay in customer-report.json for the team.
 */
export function renderCustomerReportHtml(report: CustomerReport, options: { summary?: boolean } = {}): string {
  const summary = options.summary === true;
  const date = new Date(report.generatedAt).toISOString().slice(0, 10);
  const { migrated: m } = report;
  const shown = summary ? report.shortfalls.filter((shortfall) => !shortfall.teamOnly) : report.shortfalls;
  const decisions = shown.filter((shortfall) => shortfall.needsYou);
  const notes = shown.filter((shortfall) => !shortfall.needsYou);
  const openChecks = report.checks.some((check) => check.outcome === 'failed' || check.outcome === 'not-checked');
  const allWritten = m.pagesWritten === m.pagesInScope;

  // The headline states the outcome in one sentence, because it is the only line some readers read.
  const verdict = report.release.allowed
    ? 'This migration passed every required check and is cleared for release.'
    : `This migration is not yet cleared for release: ${report.release.blockers} required check${report.release.blockers === 1 ? '' : 's'} ${report.release.blockers === 1 ? 'is' : 'are'} outstanding${decisions.length ? `, and ${decisions.length} ${decisions.length === 1 ? 'point needs' : 'points need'} your decision` : ''}.`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Migration report — ${escape(report.source.location)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; background: #fff; color: #15202b;
    font: 10.5pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
  }
  h1 { font-size: 21pt; line-height: 1.15; margin: 0 0 6pt; letter-spacing: -.01em; }
  h2 {
    font-size: 12.5pt; margin: 0 0 8pt; padding-bottom: 4pt;
    border-bottom: 1.5pt solid #15202b; letter-spacing: .02em; text-transform: uppercase;
  }
  h3 { font-size: 10.5pt; margin: 0 0 4pt; }
  p { margin: 0 0 6pt; max-width: 46em; }
  section.band { margin-bottom: 16pt; }
  /* Only the small units stay whole. A top-level band that cannot break would push a whole
     section onto the next page and leave the current one half empty. */
  .sf, .grp, tr, li { break-inside: avoid; }
  h2, h3 { break-after: avoid; }

  .head { border-bottom: 2.5pt solid #15202b; padding-bottom: 10pt; margin-bottom: 14pt; }
  .eyebrow { font-size: 8pt; letter-spacing: .16em; text-transform: uppercase; color: #5a6b7c; margin: 0 0 8pt; }
  .verdict {
    font-size: 11.5pt; font-weight: bold; margin: 10pt 0 0; padding: 8pt 10pt;
    border-left: 3pt solid ${report.release.allowed ? '#1b7552' : '#9a5c12'};
    background: ${report.release.allowed ? '#f0f7f3' : '#fbf5ec'};
  }

  table { border-collapse: collapse; width: 100%; }
  .facts { margin-bottom: 14pt; }
  .facts th, .facts td { text-align: left; padding: 3.5pt 0; vertical-align: top; font-weight: normal; border-bottom: .5pt solid #e2e8ee; }
  .facts th { width: 34%; color: #5a6b7c; }

  .counts { display: table; width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 6pt 0; margin-bottom: 4pt; }
  .counts > div { display: table-cell; border: .75pt solid #cfd8e2; padding: 7pt 9pt; text-align: center; }
  .counts b { display: block; font-size: 17pt; line-height: 1.1; }
  .counts span { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .07em; color: #5a6b7c; }

  .grp { margin-bottom: 11pt; }
  .grp h3 { border-bottom: .5pt solid #cfd8e2; padding-bottom: 3pt; }
  .score { float: right; font-weight: normal; color: #5a6b7c; font-size: 9pt; }
  .checks td { padding: 3.5pt 0; vertical-align: top; border-bottom: .5pt solid #eef2f6; }
  .checks td.o { width: 62pt; }
  .ct { font-size: 10pt; }
  .cd { color: #44586b; font-size: 9pt; margin-top: 1.5pt; }
  .cs { margin: 2pt 0 0 12pt; padding: 0; color: #44586b; font-size: 8.5pt; }
  .tag {
    display: inline-block; font-size: 7.5pt; font-weight: bold; letter-spacing: .05em;
    text-transform: uppercase; padding: 1.5pt 4pt; border: .75pt solid currentColor;
  }
  .t-verified { color: #1b7552; }
  .t-failed { color: #aa342c; }
  .t-not-checked { color: #9a5c12; }
  .t-not-applicable { color: #6b7c8c; }

  .sf { border: .75pt solid #cfd8e2; border-left: 3pt solid #6b7c8c; padding: 8pt 11pt; margin-bottom: 8pt; }
  .sf.you { border-left-color: #9a5c12; background: #fdfaf6; }
  .you-tag {
    float: right; font-size: 7.5pt; font-weight: bold; letter-spacing: .05em;
    text-transform: uppercase; color: #9a5c12; border: .75pt solid currentColor; padding: 1pt 4pt;
  }
  .items { margin: 5pt 0 0 14pt; padding: 0; font-size: 9pt; color: #2d3f50; }
  .items li { margin-bottom: 1.5pt; }
  .more { font-size: 8.5pt; color: #5a6b7c; margin-top: 5pt; font-style: italic; }
  .none { color: #1b7552; font-weight: bold; }
  .front { margin: 4pt 0 6pt 16pt; padding: 0; max-width: 46em; }
  .front li { margin-bottom: 7pt; break-inside: avoid; }
  .front .lead { font-weight: bold; }
  .front .eg { color: #44586b; }
  .hint { font-size: 8.5pt; color: #5a6b7c; font-style: italic; }
  .appendix { break-before: page; }

  footer { margin-top: 16pt; padding-top: 7pt; border-top: .5pt solid #cfd8e2; font-size: 8pt; color: #5a6b7c; }
  footer p { margin: 0 0 2pt; max-width: none; }
</style></head>
<body>

<header class="head">
  <p class="eyebrow">Documentation migration report</p>
  <h1>${escape(report.source.location)}</h1>
  <p>Moved from ${escape(PLATFORM_NAMES[report.source.platform] ?? report.source.platform)} to Documentation.AI · ${escape(date)}</p>
  <p class="verdict">${escape(verdict)}</p>
</header>

<section class="band">
  <h2>In short</h2>
  <div class="counts">
    <div><b>${m.pagesWritten}</b><span>Pages moved</span></div>
    <div><b>${m.assets}</b><span>Images &amp; files</span></div>
    <div><b>${m.redirects}</b><span>Old addresses redirected</span></div>
    <div><b>${decisions.length}</b><span>Decisions for you</span></div>
  </div>
  <p>${allWritten
      ? `Every one of the ${m.pagesInScope} pages in the agreed scope is on the new site.`
      : `${m.pagesWritten} of the ${m.pagesInScope} pages in the agreed scope are on the new site; the rest are explained below.`}
    ${m.navigationSource ? `The sidebar was rebuilt from ${escape(m.navigationSource)}, so it matches what your readers see today.` : 'The source of your sidebar was not recorded for this run.'}
    ${m.redirects ? 'Every old web address that changed now redirects to the new page, so bookmarks, search results and links from other sites keep working.' : ''}
    ${m.anchorShims ? 'Links to individual sections of a page keep landing in the right place.' : ''}
    Every page was compared, word for word, against a sealed copy of your current site taken at the start.</p>
</section>

<section class="band">
  <h2>What we need from you</h2>
  ${decisions.length
      ? `<ol class="front">${decisions.map((shortfall) => frontLine(shortfall, !summary)).join('')}</ol>
         ${summary ? '' : '<p class="hint">The complete lists behind each point are in the appendix at the end, for whoever will act on them.</p>'}`
      : '<p class="none">Nothing. No decision is waiting on you.</p>'}
</section>

<section class="band">
  <h2>Good to know</h2>
  ${notes.length
      ? `<ul class="front">${notes.map((shortfall) => frontLine(shortfall, !summary)).join('')}</ul>`
      : '<p class="none">Nothing else changed along the way.</p>'}
</section>

<section class="band">
  <h2>Checks at a glance</h2>
  ${checksAtAGlance(report.checks)}
</section>

<section class="band">
  <h2>Reference</h2>
  <table class="facts">
    ${row('Your current site', report.source.location)}
    ${row('New site preview', report.destination.previewUrl)}
    ${row('Site copy taken on', report.provenance.capturedAt?.slice(0, 10))}
    ${row('Migration reference', report.migrationId)}
  </table>
</section>

${!summary && (report.shortfalls.length || openChecks) ? `<section class="band appendix">
  <h2>Appendix — full lists</h2>
  <p>Everything summarised above, item by item, for the people who will act on it. Nothing is left out of this section.</p>
  ${report.shortfalls.map(appendixBlock).join('')}
  ${checksAppendix(report.checks)}
</section>` : ''}

<footer>
  <p>${report.fidelityMode === 'exact'
      ? 'Produced in exact mode: every statement above about your content is checked against the sealed source copy, and any difference blocks release.'
      : 'Produced in exploratory mode, which does not certify content fidelity. Checks in the fidelity family report as “not checked” rather than as passed — this run does not prove them either way.'}</p>
  ${summary ? '' : `<p>Repository ${escape(report.destination.remote ?? 'not recorded')}${report.destination.branch ? ` · branch ${escape(report.destination.branch)}` : ''} · migration build ${escape(report.provenance.migrator)} · content contract ${escape(report.provenance.contentContract)} · generated ${escape(date)}</p>`}
</footer>

</body></html>
`;
}
