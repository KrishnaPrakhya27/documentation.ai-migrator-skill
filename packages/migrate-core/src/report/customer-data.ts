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

/** At most `limit` items, with the remainder counted rather than dropped. */
function capped(items: string[], limit = 25): { items: string[]; more: number } {
  return { items: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}

const pageLabel = (page: { title?: string; source?: string; oldPath?: string }): string =>
  `${page.title || 'Untitled'}${page.oldPath || page.source ? ` — ${page.oldPath ?? page.source}` : ''}`;

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
    shortfalls.push({
      heading: `${pages.length} page${pages.length === 1 ? '' : 's'} not migrated — ${reason}`,
      explanation: 'These exist in your source but were not carried over for the reason above. If any belong in the new site, they can be added.',
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
      heading: `${substituted.length} component${substituted.length === 1 ? '' : 's'} replaced by something the migration wrote`,
      explanation: 'These could not be carried over as they were, so the migration put something in their place. The replacement text is ours, not yours, and each one points at the original tool for now — they need a home you control before you go live.',
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
      ...capped(excludedMedia.map((entry) => `${entry.describe ?? entry.url ?? entry.hash} — ${entry.reason} (approved by ${entry.approvedBy})`)),
      needsYou: true,
    });
  }

  // A help-centre hub the migration wrote: no words of its own, only the section's categories.
  if (tree.helpCenter) {
    shortfalls.push({
      heading: `1 page written by the migration: a help-centre hub for “${tree.helpCenter.container}”`,
      explanation: `Your source had no landing page for this section, so one was written at /${tree.helpCenter.hubPath}. It holds no text of ours: it renders the section's own categories as cards, drawn from the navigation. Approved by ${tree.helpCenter.approvedBy}.`,
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
      heading: `${quarantine.total} page${quarantine.total === 1 ? '' : 's'} held back during conversion`,
      explanation: `${parts.join('; ')}. Exact mode stops rather than publishing an approximation of your content.`,
      items: [], more: 0, needsYou: true,
    });
  }

  // Published pages the source sidebar never placed. They migrate as files; inventing a group for
  // them would state a structure the source does not have.
  const unlisted = readJsonIfPresent<Array<{ title?: string; newPath?: string; source?: string }>>(join(workspace, 'report', 'unlisted-pages.json'), []);
  if (unlisted.length) {
    shortfalls.push({
      heading: `${unlisted.length} page${unlisted.length === 1 ? '' : 's'} migrated but absent from the sidebar`,
      explanation: 'Your source publishes these without placing them in its navigation, so they were migrated as pages but not added to the sidebar. Putting them somewhere would invent a structure your site does not have. Tell us where they belong and we will place them.',
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
      heading: `${exclusions.length} block${exclusions.length === 1 ? '' : 's'} of content removed from inside pages`,
      explanation: 'Content removed deliberately during conversion. Each is attributed below to the rule or person that decided it.',
      ...capped([...byReason].map(([reason, count]) => `${count}× ${reason}`)),
      needsYou: false,
    });
  }

  // Links that still point at the old site, because their target is outside this migration.
  const unmigrated = readJsonIfPresent<Array<{ route: string; url: string; knownSourcePage: boolean }>>(join(workspace, 'report', 'unmigrated-links.json'), []);
  if (unmigrated.length) {
    shortfalls.push({
      heading: `${unmigrated.length} link${unmigrated.length === 1 ? ' points' : 's point'} at pages this migration does not include`,
      explanation: 'These links target pages outside the agreed scope. They still work only while your existing site stays online — decide whether to bring those pages across or repoint the links.',
      ...capped(unmigrated.map((link) => `/${link.route} → ${link.url}${link.knownSourcePage ? '' : ' (not a page your source is known to publish)'}`)),
      needsYou: true,
    });
  }

  // Images whose stated size the target cannot carry.
  const lossyDimensions = readJsonIfPresent<unknown[]>(join(workspace, 'report', 'lossy-dimensions.json'), []);
  if (lossyDimensions.length) {
    shortfalls.push({
      heading: `${lossyDimensions.length} image${lossyDimensions.length === 1 ? '' : 's'} migrated without their stated size`,
      explanation: 'Your source sizes these in percentages or relative units, which Documentation.AI images cannot express. The image is carried over; only the stated dimension is not.',
      items: [], more: 0, needsYou: false,
    });
  }

  // Headings whose id changed, where a redirect-style shim keeps old deep links landing.
  const anchors = readJsonIfPresent<Array<{ needsShim?: boolean }>>(join(workspace, 'report', 'anchors.json'), []);
  const shims = anchors.filter((anchor) => anchor.needsShim).length;
  if (shims) {
    shortfalls.push({
      heading: `${shims} heading${shims === 1 ? '' : 's'} changed address, with a redirect kept in place`,
      explanation: 'Documentation.AI generates heading ids differently from your old platform. Existing deep links to these sections keep working because a shim was written for each one — nothing to do, recorded for completeness.',
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
      heading: `${failed.length} check${failed.length === 1 ? '' : 's'} did not pass`,
      explanation: 'These block release until resolved.',
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
