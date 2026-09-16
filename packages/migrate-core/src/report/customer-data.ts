/**
 * The customer report, assembled from what the run already recorded.
 *
 * Every other report in `report/` is written for the team: gate ids, cluster hashes, node ids. This
 * one is written for the person whose documentation it is, and it answers two questions — what
 * arrived, and what did not.
 *
 * The second question is the one that matters. A migration that quietly omits 40 pages and reports
 * only its successes is worse than one that names them, because the customer finds out from a
 * reader. So nothing here summarises a shortfall away: every page not written, every block dropped,
 * every link left pointing at the old site and every check that did not pass is itemised with the
 * reason the run recorded at the time.
 *
 * Reading only. This stage invents no facts; if a run did not record something, the report says so
 * rather than filling the gap.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateSatisfied, releaseBlockers, type GateResult } from '../verify/gates.js';
import { gateLanguage, type GateGroup } from './gate-language.js';
import { describeMigrator } from '../session/provenance.js';
import { countQuarantine } from '../session/quarantine.js';
import { readBlockExclusions } from '../ir/exclusions.js';
import { readScopeDecisions } from '../evidence/scope.js';
import type { Session } from '../session/workspace.js';
import type { Tree, TreePage } from '../nav/tree.js';

export interface CustomerCheck {
  id: string;
  title: string;
  group: GateGroup;
  outcome: 'verified' | 'failed' | 'not-checked' | 'not-applicable';
  /** The gate's own words, kept verbatim when it did not pass. */
  detail: string;
  samples: string[];
}

/** One reason a thing did not arrive, with everything it applies to. */
export interface Shortfall {
  heading: string;
  /** Why, in the customer's terms. */
  explanation: string;
  /** One plain sentence for the front page: the count, what it is, and what to do. No paths. */
  summary: string;
  /** Up to three things it applies to, by name only, so the front page can say "for example". */
  examples: string[];
  /** The full list, for the appendix and the data file. */
  items: string[];
  /** Items beyond those listed, so a long list is never silently truncated. */
  more: number;
  /** Whether this needs the customer to decide something. */
  needsYou: boolean;
}

export interface CustomerReport {
  migrationId: string;
  generatedAt: string;
  source: { platform: string; location: string; kind: string };
  destination: { landing: string; remote?: string; branch?: string; previewUrl?: string };
  fidelityMode: 'exact' | 'permissive';
  release: { allowed: boolean; blockers: number };
  migrated: {
    pagesInScope: number;
    pagesWritten: number;
    assets: number;
    redirects: number;
    anchorShims: number;
    navigationSource?: string;
  };
  checks: CustomerCheck[];
  shortfalls: Shortfall[];
  provenance: { migrator: string; contentContract: string; capturedAt?: string };
}

const readJsonIfPresent = <T>(path: string, fallback: T): T => {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
};

/** At most `limit` items, with the remainder counted rather than dropped. The appendix holds these; the front page holds only a sentence. */
function capped(items: string[], limit = 200): { items: string[]; more: number } {
  return { items: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}

const pageLabel = (page: { title?: string; source?: string; oldPath?: string }): string =>
  `${page.title || 'Untitled'}${page.oldPath || page.source ? ` — ${page.oldPath ?? page.source}` : ''}`;

/** Up to three names, distinct and non-empty, for a front-page "for example". */
function examplesOf(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter((name) => name && name !== 'Untitled'))].slice(0, 3);
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/**
 * The reasons an adapter records for leaving a page out, said for a reader who has never seen the
 * source platform. An unknown reason is shown as recorded rather than reworded.
 */
const SKIP_REASON_LANGUAGE: Record<string, string> = {
  'help system out of scope': 'belong to a separate help system that was not part of this migration',
  'states no title: publishes no article': 'have no article on them (no title and no content), such as search and index placeholders',
  'not authored documentation': 'are not documentation pages (error pages, search pages, folder listings)',
  'unpublished in the source': 'are unpublished drafts on your current site',
  'not placed by the table of contents': 'are not listed in your table of contents',
  'hidden in the source navigation': 'are hidden in your navigation',
};

/** Where a link points, as a page: the address without its fragment or query, so twenty links to one page count as one target. */
function linkTarget(url: string): string {
  return url.replace(/[#?].*$/, '') || url;
}

/** A link target as a reader would name it: the page's own name, or the site it is on, never `../../x.htm`. */
function targetName(target: string): string {
  const path = target.replace(/^https?:\/\/[^/]+/, '');
  const host = /^https?:\/\//.test(target) ? target.replace(/^https?:\/\/([^/]+).*$/, '$1') : '';
  let last = path.split('/').filter((segment) => segment && segment !== '..' && segment !== '.').pop() ?? '';
  try { last = decodeURIComponent(last); } catch { /* shown as written */ }
  last = last.replace(/\.(?:html?|md|mdx|php|aspx?)$/i, '');
  if (last && host) return `${last} (on ${host})`;
  return last || host || target;
}

/** How the sidebar was established, said plainly; undefined when the run recorded nothing. */
export function navigationSourceLanguage(source: Tree['navigationSource']): string | undefined {
  switch (source) {
    case 'source-config': return "your site's own navigation file";
    case 'platform-metadata': return 'navigation data published by your site';
    case 'dom-sidebar': return 'the sidebar your site renders to readers';
    case 'manual': return 'a navigation tree reviewed and supplied by an operator';
    case 'sitemap-hint': return 'sitemap filenames (inferred, not stated by your site)';
    case 'url-path': return 'URL paths (inferred, not stated by your site)';
    default: return undefined;
  }
}

function checksFrom(gates: GateResult[]): CustomerCheck[] {
  return gates.map((gate) => {
    const language = gateLanguage(gate.id);
    const outcome: CustomerCheck['outcome'] =
      gate.status === 'pass' ? 'verified'
        : gate.status === 'inapplicable' ? 'not-applicable'
          : gate.status === 'fail' ? 'failed' : 'not-checked';
    return { id: gate.id, title: language.title, group: language.group, outcome, detail: gate.detail, samples: gate.samples ?? [] };
  });
}

/** Everything the run did not carry over, each with the reason it recorded at the time. */
function shortfallsFrom(workspace: string, tree: Tree, gates: GateResult[], fidelityMode: 'exact' | 'permissive'): Shortfall[] {
  const shortfalls: Shortfall[] = [];

  // Pages the plan deliberately did not migrate, grouped by the reason the adapter gave.
  const skipped = tree.pages.filter((page) => !page.migrate);
  const byReason = new Map<string, TreePage[]>();
  for (const page of skipped) {
    const reason = page.reason ?? 'no reason recorded';
    byReason.set(reason, [...(byReason.get(reason) ?? []), page]);
  }
  for (const [reason, pages] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
    const why = SKIP_REASON_LANGUAGE[reason] ?? `were left out (recorded reason: ${reason})`;
    shortfalls.push({
      heading: `${plural(pages.length, 'page')} not migrated — ${reason}`,
      explanation: 'These exist in your source but were not carried over for the reason above. If any belong in the new site, they can be added.',
      summary: `${plural(pages.length, 'page')} ${why}. Tell us if any of them should be on the new site.`,
      examples: examplesOf(pages.map((page) => page.title ?? '')),
      ...capped(pages.map(pageLabel)),
      needsYou: true,
    });
  }

  // Content the migration wrote in place of something it could not carry. This is the one category
  // that is the migrator's own words rather than the author's, so it is never summarised away: a
  // substitution that reached neither the exclusions nor the quarantines would be invisible here,
  // which is precisely the page a customer reads to find out what is not theirs.
  const substituted = readScopeDecisions(workspace).substituted;
  if (substituted.length) {
    const label = (entry: { component: string; reason: string; approvedBy: string; contentLoss?: boolean }) =>
      `<${entry.component}> — ${entry.contentLoss ? 'the reader loses content' : 'the reader loses a convenience'}: ${entry.reason} (approved by ${entry.approvedBy})`;
    shortfalls.push({
      heading: `${plural(substituted.length, 'component')} replaced by something the migration wrote`,
      explanation: 'These could not be carried over as they were, so the migration put something in their place. The replacement text is ours, not yours, and each one points at the original tool for now — they need a home you control before you go live.',
      summary: `${plural(substituted.length, 'interactive element')} on your old site (a live tool or demo) cannot run on the new one. In its place is a card linking to the original, which only works while your old site stays up. Decide where each should live.`,
      examples: examplesOf(substituted.map((entry) => entry.component)),
      ...capped(substituted.map(label)),
      needsYou: true,
    });
  }

  // Media the migration does not carry. The page it sat on migrated, so it appears in no exclusion
  // and no quarantine; without this the reader of the report would be told the page came over whole.
  const excludedMedia = readScopeDecisions(workspace).assets;
  if (excludedMedia.length) {
    shortfalls.push({
      heading: `${excludedMedia.length} image${excludedMedia.length === 1 ? '' : 's'} not carried over`,
      explanation: 'Your source publishes these at an address we could not host from, so the pages that used them came over without them. Everything else on those pages is yours and unchanged. Re-upload each one and place it back where it was.',
      summary: `${plural(excludedMedia.length, 'image or file')} could not be fetched from your old site (too large to download, or refused by the host), so the pages that used them came over without them. Re-upload each one and place it back.`,
      examples: examplesOf(excludedMedia.map((entry) => String(entry.describe ?? entry.url ?? entry.hash).split('/').pop() ?? '')),
      ...capped(excludedMedia.map((entry) => `${entry.describe ?? entry.url ?? entry.hash} — ${entry.reason} (approved by ${entry.approvedBy})`)),
      needsYou: true,
    });
  }

  // A help-centre hub the migration wrote: no words of its own, only the section's categories.
  if (tree.helpCenter) {
    shortfalls.push({
      heading: `1 page written by the migration: a help-centre hub for “${tree.helpCenter.container}”`,
      explanation: `Your source had no landing page for this section, so one was written at /${tree.helpCenter.hubPath}. It holds no text of ours: it renders the section's own categories as cards, drawn from the navigation. Approved by ${tree.helpCenter.approvedBy}.`,
      summary: `A landing page was added for “${tree.helpCenter.container}”, because your old site had none. It shows the section's own categories as cards and contains no text of ours.`,
      examples: [],
      items: [], more: 0, needsYou: false,
    });
  }

  // Pages held back at conversion: a snippet that could not be resolved, or content exact mode
  // refused to approximate.
  const quarantine = countQuarantine(workspace);
  if (quarantine.total) {
    const parts = [
      quarantine.blockedSnippet ? `${quarantine.blockedSnippet} held because an included snippet could not be resolved` : '',
      quarantine.exactFidelity ? `${quarantine.exactFidelity} held because the content could not be carried over without changing it` : '',
    ].filter(Boolean);
    shortfalls.push({
      heading: `${plural(quarantine.total, 'page')} held back during conversion`,
      explanation: `${parts.join('; ')}. Exact mode stops rather than publishing an approximation of your content.`,
      summary: `${plural(quarantine.total, 'page')} ${quarantine.total === 1 ? 'was' : 'were'} held back because ${quarantine.total === 1 ? 'it' : 'they'} could not be carried over exactly as written. We stop rather than publish an approximation; each will be resolved with you before going live.`,
      examples: [],
      items: [], more: 0, needsYou: true,
    });
  }

  // Published pages the source sidebar never placed. They migrate as files; inventing a group for
  // them would state a structure the source does not have.
  const unlisted = readJsonIfPresent<Array<{ title?: string; newPath?: string; source?: string }>>(join(workspace, 'report', 'unlisted-pages.json'), []);
  if (unlisted.length) {
    shortfalls.push({
      heading: `${plural(unlisted.length, 'page')} migrated but absent from the sidebar`,
      explanation: 'Your source publishes these without placing them in its navigation, so they were migrated as pages but not added to the sidebar. Putting them somewhere would invent a structure your site does not have. Tell us where they belong and we will place them.',
      summary: `${plural(unlisted.length, 'page')} exist on your old site but are not in its menu, so they were migrated as pages without a place in the sidebar. They open by address and in search. Tell us where they belong and we will place them.`,
      examples: examplesOf(unlisted.map((page) => page.title ?? '')),
      ...capped(unlisted.map((page) => `${page.title || 'Untitled'}${page.newPath ? ` — /${page.newPath}` : ''}`)),
      needsYou: true,
    });
  }

  // Content dropped from inside a page, each attributed to whoever decided it.
  const exclusions = readBlockExclusions(workspace);
  if (exclusions.length) {
    const byReason = new Map<string, number>();
    for (const exclusion of exclusions) byReason.set(`${exclusion.reason} (decided by ${exclusion.reviewer})`, (byReason.get(`${exclusion.reason} (decided by ${exclusion.reviewer})`) ?? 0) + 1);
    shortfalls.push({
      heading: `${plural(exclusions.length, 'block')} of content removed from inside pages`,
      explanation: 'Content removed deliberately during conversion. Each is attributed below to the rule or person that decided it.',
      summary: `${plural(exclusions.length, 'element')} inside pages ${exclusions.length === 1 ? 'was' : 'were'} removed on purpose (scripts, embedded widgets and similar that cannot run on the new site). Each removal is recorded with who decided it.`,
      examples: [],
      ...capped([...byReason].map(([reason, count]) => `${count}× ${reason}`)),
      needsYou: false,
    });
  }

  // Links that still point at the old site, because their target is outside this migration.
  const unmigrated = readJsonIfPresent<Array<{ route: string; url: string; knownSourcePage: boolean }>>(join(workspace, 'report', 'unmigrated-links.json'), []);
  if (unmigrated.length) {
    // Twenty links to one page are one decision, so the front page speaks in targets, not links.
    // resolved against the page that holds the link, so `../../Default.htm` and `../../../Default.htm`
    // written on two pages are the one page they both reach
    const resolved = (link: { route: string; url: string }): string => {
      const target = linkTarget(link.url);
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/')) return target;
      try { return new URL(target, `https://source.invalid/${link.route}`).pathname; } catch { return target; }
    };
    const byTarget = new Map<string, number>();
    for (const link of unmigrated) byTarget.set(resolved(link), (byTarget.get(resolved(link)) ?? 0) + 1);
    const targets = [...byTarget].sort((a, b) => b[1] - a[1]);
    // two different pages with one name (a `Default.htm` in each help system) are told apart by address
    const names = targets.slice(0, 3).map(([target]) => targetName(target));
    const top = targets.slice(0, 3).map(([target, count], index) => `the page “${names.filter((name) => name === names[index]).length > 1 ? `${names[index]} (${target})` : names[index]}”, ${plural(count, 'link')}`);
    shortfalls.push({
      heading: `${unmigrated.length} link${unmigrated.length === 1 ? ' points' : 's point'} at pages this migration does not include`,
      explanation: 'These links target pages outside the agreed scope. They still work only while your existing site stays online — decide whether to bring those pages across or repoint the links.',
      summary: `${plural(unmigrated.length, 'link')} in your pages go to ${plural(targets.length, 'page')} that ${targets.length === 1 ? 'was' : 'were'} not migrated. They keep working only while your old site is online. Decide whether to bring those pages across or change the links.`,
      examples: top,
      ...capped(unmigrated.map((link) => `/${link.route} → ${link.url}${link.knownSourcePage ? '' : ' (not a page your source is known to publish)'}`)),
      needsYou: true,
    });
  }

  // Images whose stated size the target cannot carry.
  const lossyDimensions = readJsonIfPresent<unknown[]>(join(workspace, 'report', 'lossy-dimensions.json'), []);
  if (lossyDimensions.length) {
    shortfalls.push({
      heading: `${plural(lossyDimensions.length, 'image')} migrated without their stated size`,
      explanation: 'Your source sizes these in percentages or relative units, which Documentation.AI images cannot express. The image is carried over; only the stated dimension is not.',
      summary: `${plural(lossyDimensions.length, 'image')} ${lossyDimensions.length === 1 ? 'is' : 'are'} shown at the new site's default size rather than the relative size your old site set. The images themselves are all there.`,
      examples: [],
      items: [], more: 0, needsYou: false,
    });
  }

  // Headings whose id changed, where a redirect-style shim keeps old deep links landing.
  const anchors = readJsonIfPresent<Array<{ needsShim?: boolean }>>(join(workspace, 'report', 'anchors.json'), []);
  const shims = anchors.filter((anchor) => anchor.needsShim).length;
  if (shims) {
    shortfalls.push({
      heading: `${plural(shims, 'heading')} changed address, with a redirect kept in place`,
      explanation: 'Documentation.AI generates heading ids differently from your old platform. Existing deep links to these sections keep working because a shim was written for each one — nothing to do, recorded for completeness.',
      summary: `${plural(shims, 'section heading')} got a new web address on the new platform. Old links to those sections still land in the right place; nothing to do.`,
      examples: [],
      items: [], more: 0, needsYou: false,
    });
  }

  // Checks that did not pass. In permissive mode the exact-fidelity family reports not-run, which
  // is a real limit on what this run proves and is stated as one.
  const unmet = gates.filter((gate) => !gateSatisfied(gate));
  const failed = unmet.filter((gate) => gate.status === 'fail');
  const notRun = unmet.filter((gate) => gate.status === 'not-run');
  if (failed.length) {
    shortfalls.push({
      heading: `${plural(failed.length, 'check')} did not pass`,
      explanation: 'These block release until resolved.',
      summary: `${plural(failed.length, 'check')} did not pass yet. Our team resolves these before release; they are listed under “Checks” with what each one means.`,
      examples: examplesOf(failed.map((gate) => gateLanguage(gate.id).title)),
      ...capped(failed.map((gate) => `${gateLanguage(gate.id).title} — ${gate.detail}`)),
      needsYou: false,
    });
  }
  if (notRun.length) {
    shortfalls.push({
      heading: `${notRun.length} check${notRun.length === 1 ? ' was' : 's were'} not run`,
      explanation: fidelityMode === 'permissive'
        ? 'This migration ran in exploratory mode, which does not certify content fidelity. These checks report as not run rather than as passed — this run does not prove them either way.'
        : 'These checks did not run. They are reported as not run rather than as passed.',
      summary: fidelityMode === 'permissive'
        ? `${plural(notRun.length, 'check')} did not run because this was an exploratory run, which does not certify that content is word-for-word identical. A final run in exact mode proves that.`
        : `${plural(notRun.length, 'check')} could not run yet (for example, checks that need the live preview). They are reported as not run, never as passed.`,
      examples: [],
      ...capped(notRun.map((gate) => `${gateLanguage(gate.id).title} — ${gate.detail}`)),
      needsYou: false,
    });
  }

  return shortfalls;
}

export function buildCustomerReport(input: {
  workspace: string;
  session: Session;
  tree: Tree;
  gates: GateResult[];
  assets: number;
  redirects: number;
  generatedAt?: string;
}): CustomerReport {
  const { workspace, session, tree, gates } = input;
  const fidelityMode = session.fidelityMode ?? 'exact';
  const anchors = readJsonIfPresent<Array<{ needsShim?: boolean }>>(join(workspace, 'report', 'anchors.json'), []);
  const inScope = tree.pages.filter((page) => page.migrate);
  const written = inScope.filter((page) => page.newPath && existsSync(join(workspace, 'output', `${page.newPath}.mdx`)));

  return {
    migrationId: session.migrationId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: { platform: tree.platform, location: session.source.location, kind: session.source.kind },
    destination: {
      landing: session.target.landing,
      remote: session.target.repoRemote,
      branch: session.stages.write?.note,
      previewUrl: session.target.previewUrl,
    },
    fidelityMode,
    release: { allowed: releaseBlockers(gates).length === 0, blockers: releaseBlockers(gates).length },
    migrated: {
      pagesInScope: inScope.length,
      pagesWritten: written.length,
      assets: input.assets,
      redirects: input.redirects,
      anchorShims: anchors.filter((anchor) => anchor.needsShim).length,
      navigationSource: navigationSourceLanguage(tree.navigationSource),
    },
    checks: checksFrom(gates),
    shortfalls: shortfallsFrom(workspace, tree, gates, fidelityMode),
    provenance: {
      migrator: describeMigrator(session.migrator),
      contentContract: session.versions.contentContract,
      capturedAt: session.stages.acquire?.at,
    },
  };
}
