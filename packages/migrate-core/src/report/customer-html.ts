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
import { GATE_GROUP_ORDER, GATE_GROUP_TITLES, type GateGroup } from './gate-language.js';

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

function checkGroup(group: GateGroup, checks: CustomerCheck[]): string {
  const mine = checks.filter((check) => check.group === group);
  if (!mine.length) return '';
  // Anything unresolved sorts to the top of its group: on a printed page the reader should not
  // have to scan a list of passes to find the one line that needs them.
  const rank: Record<CustomerCheck['outcome'], number> = { failed: 0, 'not-checked': 1, verified: 2, 'not-applicable': 3 };
  const sorted = [...mine].sort((a, b) => rank[a.outcome] - rank[b.outcome]);
  const met = mine.filter((check) => check.outcome === 'verified' || check.outcome === 'not-applicable').length;
  return `<section class="grp">
      <h3>${escape(GATE_GROUP_TITLES[group])} <span class="score">${met} of ${mine.length}</span></h3>
      <table class="checks">${sorted.map(checkRow).join('')}</table>
    </section>`;
}

function shortfallBlock(shortfall: Shortfall): string {
  return `<section class="sf${shortfall.needsYou ? ' you' : ''}">
      <h3>${escape(shortfall.heading)}${shortfall.needsYou ? '<span class="you-tag">Needs your decision</span>' : ''}</h3>
      <p>${escape(shortfall.explanation)}</p>
    </section>`;
}

const row = (label: string, value?: string): string =>
  value ? `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>` : '';

export function renderCustomerReportHtml(report: CustomerReport): string {
  const date = new Date(report.generatedAt).toISOString().slice(0, 10);
  const { migrated: m } = report;
  const needsYou = report.shortfalls.filter((shortfall) => shortfall.needsYou).length;
  const allWritten = m.pagesWritten === m.pagesInScope;

  // The headline states the outcome in one sentence, because it is the only line some readers read.
  const verdict = report.release.allowed
    ? 'This migration passed every required check and is cleared for release.'
    : `This migration is not yet cleared for release: ${report.release.blockers} required check${report.release.blockers === 1 ? '' : 's'} ${report.release.blockers === 1 ? 'is' : 'are'} outstanding.`;

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

  footer { margin-top: 16pt; padding-top: 7pt; border-top: .5pt solid #cfd8e2; font-size: 8pt; color: #5a6b7c; }
  footer p { margin: 0 0 2pt; max-width: none; }
</style></head>
<body>

<header class="head">
  <p class="eyebrow">Documentation migration report</p>
  <h1>${escape(report.source.location)}</h1>
  <p>Migrated from ${escape(PLATFORM_NAMES[report.source.platform] ?? report.source.platform)} to Documentation.AI · ${escape(date)}</p>
  <p class="verdict">${escape(verdict)}</p>
</header>

<section class="band">
  <h2>What was migrated</h2>
  <div class="counts">
    <div><b>${m.pagesWritten}</b><span>Pages written</span></div>
    <div><b>${m.assets}</b><span>Images &amp; files</span></div>
    <div><b>${m.redirects}</b><span>Redirects</span></div>
    <div><b>${m.anchorShims}</b><span>Anchors kept</span></div>
  </div>
  <p>${allWritten
      ? `All ${m.pagesInScope} pages in the agreed scope were written.`
      : `${m.pagesWritten} of ${m.pagesInScope} pages in the agreed scope were written; the difference is itemised under “What did not carry over”.`}
    ${m.navigationSource ? `Your sidebar was rebuilt from ${escape(m.navigationSource)}.` : 'The source of your sidebar was not recorded for this run.'}
    ${m.redirects ? `Every old URL that changed has a redirect, so existing links and search results keep working.` : ''}</p>
</section>

<section class="band">
  <h2>What did not carry over</h2>
  ${report.shortfalls.length
      ? `<p>A short summary of what was handled differently, and why.${needsYou ? ` ${needsYou} item${needsYou === 1 ? '' : 's'} need${needsYou === 1 ? 's' : ''} a decision from you.` : ''} The full page-by-page lists are kept alongside this report and are available on request.</p>
         ${report.shortfalls.map(shortfallBlock).join('')}`
      : '<p class="none">Nothing. Every page, link, image and heading in your source was carried over, and every check passed.</p>'}
</section>

<section class="band">
  <h2>What was checked</h2>
  <p>Each page was compared against a sealed copy of your source taken at the start of the migration — not against the output of the migration itself.</p>
  ${GATE_GROUP_ORDER.map((group) => checkGroup(group, report.checks)).join('')}
</section>

<section class="band">
  <h2>Reference</h2>
  <table class="facts">
    ${row('Source', `${report.source.location} (${report.source.kind})`)}
    ${row('Source platform', report.source.platform)}
    ${row('Repository', report.destination.remote)}
    ${row('Branch', report.destination.branch)}
    ${row('Preview', report.destination.previewUrl)}
    ${row('Source captured', report.provenance.capturedAt?.slice(0, 10))}
    ${row('Migration reference', report.migrationId)}
  </table>
</section>

<footer>
  <p>${report.fidelityMode === 'exact'
      ? 'Produced in exact mode: every statement above about your content is checked against the sealed source copy, and any difference blocks release.'
      : 'Produced in exploratory mode, which does not certify content fidelity. Checks in the fidelity family report as “not checked” rather than as passed — this run does not prove them either way.'}</p>
  <p>Migration build ${escape(report.provenance.migrator)} · content contract ${escape(report.provenance.contentContract)} · generated ${escape(date)}</p>
</footer>

</body></html>
`;
}
