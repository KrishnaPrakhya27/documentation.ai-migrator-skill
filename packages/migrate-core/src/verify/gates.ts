/**
 * Release gates. Any failure blocks release. Gates that need a preview or a
 * browser report `not-run` and count as failed unless explicitly allowed.
 */
import { readdirSync, readFileSync, existsSync, statSync, lstatSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validateMdx, validateNavigation } from '@dai/content-contract';
import { Ledger, effectiveExclusions, summarize, type LedgerSummary } from '../ledger/dispositions.js';
import type { Block, DocIR, Inline } from '../ir/types.js';
import { walkBlocks, inlineText } from '../ir/types.js';
import { redirectMaps, readUrlPlan } from '../urls/plan.js';
import { redirectProblems } from '../urls/redirect-graph.js';
import type { SiteLinks } from '../urls/site-links.js';
import { sha256 } from '../session/ids.js';
import { isSafeUrl } from '../components/sanitize.js';
import { readManifest, type AssetManifest } from '../assets/manifest.js';
import { markdownToIr } from '../ir/from-markdown.js';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import { fidelityEqual, firstFidelityDifference, renderedDocSnapshot } from './fidelity.js';
import { isConvertedFidelityRecord, readFidelityRecords } from './fidelity-records.js';
import { describeMigrator, migratorDrift, type MigratorProvenance } from '../session/provenance.js';
import { chromeAbsent, documentLinks, htmlReconciliation, sourceContentExact, sourceMetadataExact, type RawSourcePage, type SourceComparison } from './source-truth.js';
import { documentAnchors, unresolvedFragments, htmlAnchors, splitInheritedFragments } from './fragments.js';
import type { ScrapeProfile } from '../scrape/profiles.js';
import { requireSourceManifest, sourceUniverseProblems } from '../evidence/verify.js';
import { requireAcquisition } from '../evidence/acquisition.js';
import { inapplicableProofs } from '../evidence/applicability.js';
import type { SpecManifest } from '../openapi/graph.js';

export type GateStatus = 'pass' | 'fail' | 'not-run' | 'inapplicable';
export interface GateResult { id: string; status: GateStatus; detail: string; count?: number; samples?: string[] }

/** A proof that cannot exist for this source kind is complete, not skipped. */
export function gateSatisfied(gate: GateResult): boolean {
  return gate.status === 'pass' || gate.status === 'inapplicable';
}

const PREVIEW_ONLY_GATES = new Set(['preview-contract-version', 'browser-fragments', 'browser-content', 'responsive-layout']);
export const REQUIRED_RELEASE_GATE_IDS = [
  'openapi-preserved',
  'source-manifest-pinned', 'source-universe-accounted',
  'plans-pinned', 'pages-accounted', 'block-dispositions', 'exclusions-attributed',
  'no-authored-exclusions', 'conversion-fidelity', 'serialized-output-exact',
  'no-unsafe-urls', 'assets-ready', 'prose-match', 'code-blocks-exact', 'tables-exact',
  'source-content-exact', 'source-metadata-exact', 'html-reconciliation', 'chrome-absent',
  'contract-valid', 'navigation-valid', 'navigation-exact', 'source-navigation-proven', 'internal-links', 'unmigrated-links', 'no-unresolved-blocks',
  'headings-sequence', 'fragments-resolve', 'redirects-clean', 'no-unreviewed-decisions', 'deterministic-rerun',
  'preview-contract-version', 'browser-fragments', 'browser-content', 'responsive-layout',
  'migrator-pinned', 'human-gates-approved',
] as const;

/** Gates that certify exactness against the source. A permissive session reports them `not-run`; it never passes them. */
export const EXACT_FAMILY_GATE_IDS = [
  'openapi-preserved',
  'source-manifest-pinned', 'source-universe-accounted',
  'no-authored-exclusions', 'conversion-fidelity', 'serialized-output-exact', 'navigation-exact', 'source-navigation-proven',
  'source-content-exact', 'source-metadata-exact', 'html-reconciliation', 'chrome-absent',
] as const;

/** HTML elements whose subtree is never authored content, so a rule may drop them in exact mode; dropping anything else is an authored exclusion. */
/**
 * Nodes that carry nothing an author wrote, so a rule may drop one without removing content.
 * `esm` is MDX's own `import`/`export` syntax: module wiring, not prose, and the one kind of node
 * a static target must never emit. It belongs here with script and style rather than being counted
 * as authored text an exact migration silently lost.
 */
export const HTML_CHROME_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'esm', 'br']);

/** A GitBook Assistant prompt (`<button data-action="ask">`) works only inside GitBook: platform chrome, like script and style. */
function isPlatformChromeButton(block: Block): boolean {
  return block.type === 'component' && block.name === 'button' && block.props['data-action'] === 'ask';
}

export function isHtmlChromeNode(block: Block | undefined): boolean {
  return block?.type === 'component' && (HTML_CHROME_ELEMENTS.has(block.name) || isPlatformChromeButton(block));
}

/** Reviewer recorded by the rules engine when a mapping rule, not a person, dropped a node. */
const RULE_REVIEWER = /^rule:/;

export interface PushBlockerOptions {
  /**
   * Waive the exact-fidelity gates a permissive session leaves `not-run`, so an operator
   * can push an exploratory branch and look at a real preview. It waives only "not proven";
   * a gate that actually failed still blocks, and so does a missing result. Never set this
   * for a customer migration: the branch it produces is not a certified migration.
   */
  allowUnprovenExactness?: boolean;
}

/** A migration branch may be pushed to create its preview only after every
 * non-preview gate is satisfied. Final release requires every required gate to be satisfied. */
export function previewPushBlockers(gates: GateResult[], options: PushBlockerOptions = {}): GateResult[] {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const missing = REQUIRED_RELEASE_GATE_IDS.filter((id) => !byId.has(id)).map((id): GateResult => ({ id, status: 'fail', detail: 'required gate result is missing' }));
  const waived = new Set<string>(options.allowUnprovenExactness ? EXACT_FAMILY_GATE_IDS : []);
  return [...missing, ...gates.filter((gate) => !gateSatisfied(gate)
    && !(gate.status === 'not-run' && PREVIEW_ONLY_GATES.has(gate.id))
    && !(gate.status === 'not-run' && waived.has(gate.id)))];
}

/** A release certificate requires a result for every required gate and no unresolved result. */
export function releaseBlockers(gates: GateResult[]): GateResult[] {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const missing = REQUIRED_RELEASE_GATE_IDS.filter((id) => !byId.has(id)).map((id): GateResult => ({ id, status: 'fail', detail: 'required gate result is missing' }));
  return [...missing, ...gates.filter((gate) => !gateSatisfied(gate))];
}

/** The exact-fidelity gates a push waived, for the operator message and the run report. */
export function waivedExactnessGates(gates: GateResult[]): GateResult[] {
  const family = new Set<string>(EXACT_FAMILY_GATE_IDS);
  return gates.filter((gate) => gate.status === 'not-run' && family.has(gate.id));
}

export function listMdx(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== '.git') listMdx(p, out); }
    else if (/\.mdx?$/.test(f)) out.push(p);
  }
  return out;
}

/** Normalised prose segments: paragraphs, list items, headings, table cells. */
/** Ids of the blocks inside platform chrome (script, style, a GitBook assistant prompt): their text is not content the output must carry. */
function chromeContentIds(doc: DocIR): Set<string> {
  const ids = new Set<string>();
  walkBlocks(doc.children, (b) => { if (b.type === 'component' && isHtmlChromeNode(b)) walkBlocks(b.children, (inner) => { ids.add(inner.id); }); });
  return ids;
}

/**
 * Prose text of an inline run, spaced the way `normaliseMdxText` spaces the output: an inline image
 * becomes ` alt ` there, so it has to separate its neighbours here too. Without that, two cards
 * rendered side by side compare as one run — `…"buy one, get one free" offer` followed by
 * `Send 50% discount…` joins into `offersend` and the segment reads as missing though every word
 * of it is in the output.
 */
function proseText(nodes: Inline[] | undefined): string {
  if (!nodes) return '';
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return n.value;
      case 'inlineCode': return n.value;
      case 'break': return '\n';
      case 'image': return ` ${n.alt} `;
      // Raw inline HTML (`<u>prior to store catalog ingest</u>`) is emitted as written, and the output
      // normaliser strips its tags and keeps the words. Dropping it here instead would cut the words
      // out of the middle of a sentence and report the whole sentence missing.
      case 'inlineHtml': return ` ${n.value.replace(/<[^<>]*>/g, ' ')} `;
      default: return proseText((n as { children?: Inline[] }).children);
    }
  }).join('');
}

/**
 * Source IR text is text, never markup. An angle bracket the author wrote (`<%= user.first_name %>`
 * in a template example) must survive tag-stripping exactly as the serializer's character reference
 * does on the output side, or the two sides normalise differently and the segment reads as missing.
 */
function escapeSourceText(text: string): string {
  // Only `<`, exactly as the serializer writes it: a bare `>` stays literal in the output and is
  // normalised away there, so escaping it here would make the two sides disagree the other way.
  return text.replace(/</g, '&lt;');
}

/**
 * `excludedIds` are the node ids the ledger records as excluded for this page. A block removed by a
 * reviewed plan decision is accounted for there; counting it here as well would report the operator's
 * own approved exclusion as lost prose.
 */
export function proseSegments(doc: DocIR, excludedIds: ReadonlySet<string> = new Set()): string[] {
  const segs: string[] = [];
  const norm = (s: string) => normaliseMdxText(escapeSourceText(s)).trim();
  const chrome = chromeContentIds(doc);
  walkBlocks(doc.children, (b) => {
    if (chrome.has(b.id) || excludedIds.has(b.id)) return;
    if (b.type === 'paragraph' || b.type === 'heading') { const t = norm(proseText(b.children)); if (t.length >= 12) segs.push(t); }
    else if (b.type === 'table') for (const r of b.children) for (const c of r.children) { const t = norm(proseText(c.children)); if (t.length >= 12) segs.push(t); }
  });
  return segs;
}

export function normaliseMdxText(mdx: string): string {
  return mdx
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    // the one expression the contract allows; any other brace is text, which the serializer writes as a character reference
    .replace(/\{user\.[A-Za-z_]\w*\}/g, ' ')
    // brace references read as the braces they stand for, so escaped output text compares with the source's text
    .replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    .replace(/<Image\b[^>]*\balt="([^"]*)"[^>]*\/?>/gi, ' $1 ')
    .replace(/<Step\b[^>]*\btitle="([^"]*)"[^>]*>/g, ' $1 ')
    // a tag opens with a name; a literal `<` (`1 < 2`, `<<remove`) is text, and no tag reaches past the next `<`
    .replace(/<\/?[A-Za-z][^<>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`\\]+/g, '')
    .replace(/[#>|-]+/g, ' ')
    // a less-than written as a reference is text, so it is read only once tags are gone
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    // the space a code span is padded with before punctuation is not text
    .replace(/ ([,.;:!?])/g, '$1')
    .toLowerCase();
}

/**
 * Text taken from the IR, which is what the author wrote and never markup: a heading reading
 * "<move>What are the attributes…" holds those characters because the source wrote them escaped.
 * Read as MDX it would be stripped as a tag, while the output keeps it, and the two sides would
 * disagree about a page that converted perfectly. Escaping the one character the serializer escapes,
 * and only that one, puts both sides in the spelling the output actually carries.
 */
export function normaliseSourceText(text: string): string {
  return normaliseMdxText(text.replace(/</g, '&lt;'));
}

/** Ordered outline: heading depth + normalised text. Structure must survive one to one, not just the words. */
/**
 * A step with no title of its own (GitBook) opens with the heading that becomes its Step title, and a
 * Step whose title renders as a heading (`titleType="h2"|"h3"`) stands for that heading: both outlines
 * record the pair as `step:<text>`. A source step that carries a title (Mintlify) keeps its headings as headings.
 */
export function headingOutline(doc: DocIR): string[] {
  const out: string[] = [];
  const chrome = chromeContentIds(doc);
  const stepTitles = new Set<string>();
  walkBlocks(doc.children, (b) => {
    if (b.type === 'component' && b.name.toLowerCase() === 'step' && !b.props.title && b.children[0]?.type === 'heading') stepTitles.add(b.children[0].id);
  });
  walkBlocks(doc.children, (b) => {
    if (b.type !== 'heading' || chrome.has(b.id)) return;
    const text = normaliseSourceText(inlineText(b.children)).trim();
    out.push(stepTitles.has(b.id) ? `step:${text}` : `${b.depth}:${text}`);
  });
  return out;
}

export function mdxHeadingOutline(mdx: string): string[] {
  const body = mdx.replace(/^---[\s\S]*?---\n/, '').replace(/^ {0,8}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n {0,8}\1[ \t]*$/gm, '');
  return [...body.matchAll(/^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]?)*(#{1,6})(?:[ \t]+|$)(.*?)[ \t]*$|<Step\b([^>]*)>/gm)].flatMap((m) => {
    if (m[1]) return [`${m[1].length}:${normaliseMdxText(m[2]).trim()}`];
    const title = m[3].match(/\btitle="([^"]*)"/)?.[1];
    return title !== undefined && /\btitleType="h[23]"/.test(m[3]) ? [`step:${normaliseMdxText(title).trim()}`] : [];
  });
}

export function codeBlocks(doc: DocIR): string[] {
  const out: string[] = [];
  walkBlocks(doc.children, (b) => { if (b.type === 'code') out.push(b.value.replace(/\s+$/gm, '')); });
  return out;
}

export function mdxCodeBlocks(mdx: string): string[] {
  // fences may be indented (children of components and list items); dedent captured lines by the fence's own indent
  return [...mdx.matchAll(/^( {0,8})(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm)].map((m) => m[3].split('\n').map((l) => (m[1] && l.startsWith(m[1]) ? l.slice(m[1].length) : l)).join('\n').replace(/\n$/, '').replace(/\s+$/gm, ''));
}

function tableCellText(value: string): string {
  return normaliseMdxText(value).trim();
}

export function tableSignatures(doc: DocIR): string[] {
  const out: string[] = [];
  walkBlocks(doc.children, (b) => {
    if (b.type !== 'table') return;
    const rows = b.children.map((row) => row.children.map((cell) => tableCellText(inlineText(cell.children))));
    // an empty header row shows the reader nothing, and the MDX reader drops it the same way
    if (rows.length && rows[0].every((cell) => !cell)) rows.shift();
    out.push(JSON.stringify(rows));
  });
  return out;
}

function splitTableRow(line: string): string[] {
  const marker = '\u0000PIPE\u0000';
  let value = line.trim().replace(/\\\|/g, marker);
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map((cell) => tableCellText(cell.replaceAll(marker, '|')));
}

export function mdxTableSignatures(mdx: string): string[] {
  // a table inside a quote is still a table; its `>` markers are not cell text
  const lines = mdx.split(/\r?\n/).map((line) => line.replace(/^[ \t]*(?:>[ \t]?)+/, ''));
  const out: string[] = [];
  const separator = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)*\s*:?-{3,}:?\s*\|?\s*$/; // one or more columns
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes('|') || !separator.test(lines[i + 1])) continue;
    const rows = [splitTableRow(lines[i])];
    let j = i + 2;
    while (j < lines.length && lines[j].includes('|') && lines[j].trim()) rows.push(splitTableRow(lines[j++]));
    if (rows[0].every((cell) => !cell)) rows.shift();
    out.push(JSON.stringify(rows));
    i = j - 1;
  }
  return out;
}

/**
 * What the source itself said, gathered outside the gates so they compare
 * against the acquisition rather than against the migrator's own snapshot.
 */
export interface SourceEvidence {
  /** Raw acquired pages paired with the files convert wrote. */
  pages: RawSourcePage[];
  /** The source platform, for re-parsing its published Markdown and rendered HTML. */
  platform: string;
  /** The scrape profile whose selectors and chrome strings describe the rendered page. */
  profile?: ScrapeProfile;
  /** Navigation re-extracted from the frozen source, independent of the tree the migration built. */
  navigation?: Record<string, unknown>;
  /** How that re-extraction was obtained, for the report. */
  navigationSource?: string;
  /** Routes the source's own page index lists, so a page cannot silently vanish. */
  indexedRoutes?: string[];
  /** The asset manifest the conversion used, so a rehosted asset is compared by what it is and not by where it is served. */
  assets?: AssetManifest;
  /** The source put through the losses the approved mapping rules declare, so a reviewed loss is not read as a difference. */
  declaredLosses?: (doc: DocIR) => DocIR;
  /** Where the source's site-relative links land in the migrated site, so the source is compared as convert rewrote it. */
  links?: SiteLinks;
}

export interface GateInput {
  workspace: string;
  outputDir: string;
  /** Raw source evidence. Absent for sources the migrator cannot re-read, which makes the exact-source gates `not-run`. */
  sourceEvidence?: SourceEvidence;
  /**
   * Plan file hashes the session pinned at convert. A plan edited afterwards means the
   * output no longer follows the reviewed decisions, so the gate fails; omitting these
   * reports the gate `not-run`, never `pass`.
   */
  pinnedPlans?: { componentPlan?: string; urlPlan?: string; assetPlan?: string; blockExclusions?: string; scopeDecisions?: string };
  pinnedSourceManifest?: string;
  pinnedAcquisition?: string;
  pinnedOpenapi?: string;
  /** Source docs from the snapshot (IR JSON). */
  /**
   * The frozen pages paired with what was written for them. An iterable rather than an array so a
   * large migration can stream them from disk: the gates walk them several times, so whatever is
   * passed must be iterable more than once — an array is.
   */
  sourceDocs: Iterable<{ doc: DocIR; outputFile?: string }>;
  treePages: Array<{ id: string; source?: string; migrate: boolean; newPath?: string }>;
  quarantinedPages: Set<string>;
  excludedPages: Set<string>;
  unreviewed: number;
  /** Hash of the last convert and of the convert before it over identical inputs; both are convert-time hashes. */
  previousCanonicalHash?: string;
  convertOutputHash?: string;
  previewUrl?: string;
  pinnedContractVersion: string;
  previewContractVersion?: string;
  fidelityMode?: 'exact' | 'permissive';
  sourceKind?: 'url' | 'export' | 'repo' | 'api';
  /** Why the human gates do not hold, or an empty list when they do; undefined when not consulted. */
  approvalProblems?: string[];
  navigationSource?: string;
  expectedNavigation?: Record<string, unknown>;
  /** Provenance pinned at init and the build running verify; the gates certify output of the pinned build only. */
  pinnedMigrator?: MigratorProvenance;
  currentMigrator?: MigratorProvenance;
}

export function canonicalHash(outputDir: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name); const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`output contains a symbolic link: ${file}`);
      if (stat.isDirectory()) walk(file); else if (stat.isFile()) files.push(file);
    }
  };
  walk(outputDir);
  const h = files.map((f) => `${relative(outputDir, f)}\n${sha256(readFileSync(f))}`).join('\n');
  return sha256(h);
}

export function runGates(input: GateInput): GateResult[] {
  const gates: GateResult[] = [];
  const outMdx = listMdx(input.outputDir);
  const outByPath = new Map(outMdx.map((f) => [relative(input.outputDir, f).replace(/\.mdx?$/, ''), f]));
  const specProblems: string[] = [];
  const specFile = join(input.workspace, 'inventory', 'openapi.json');
  if (existsSync(specFile) || input.pinnedOpenapi) {
    if (!existsSync(specFile) || !input.pinnedOpenapi || sha256(readFileSync(specFile)) !== input.pinnedOpenapi) specProblems.push('OpenAPI manifest is missing, changed or unpinned');
    else {
      const specs = JSON.parse(readFileSync(specFile, 'utf8')) as SpecManifest;
      for (const spec of specs.documents) {
        if (spec.file !== `${sha256(spec.source)}.json`) { specProblems.push('OpenAPI manifest has an invalid file path'); continue; }
        const source = join(input.workspace, 'source-cache', 'openapi', `${sha256(spec.source)}.source`);
        const output = join(input.outputDir, 'openapi', spec.file);
        if (!existsSync(source) || sha256(readFileSync(source)) !== spec.sourceHash) specProblems.push(`${spec.source}: frozen spec changed`);
        if (!existsSync(output) || sha256(readFileSync(output)) !== spec.outputHash) specProblems.push(`${spec.source}: output spec missing or changed`);
      }
    }
  }
  // The human gates are decisions, not prose: a release is refused while one is unapproved, or
  // while the state an approval covered has changed since it was given.
  gates.push(input.approvalProblems === undefined
    ? { id: 'human-gates-approved', status: 'not-run', detail: 'human gate approvals were not consulted for this check' }
    : {
      id: 'human-gates-approved',
      status: input.approvalProblems.length ? 'fail' : 'pass',
      detail: input.approvalProblems.length ? input.approvalProblems.join('; ') : 'every human gate reached so far is approved for the state that exists now',
      count: input.approvalProblems.length,
      samples: input.approvalProblems.slice(0, 4),
    });

  const catalogFile = join(input.workspace, 'inventory', 'readme-api-catalog.json');
  if (existsSync(catalogFile) && input.treePages.some((page) => page.migrate && /\/reference\//.test(page.source ?? ''))) {
    const catalog = JSON.parse(readFileSync(catalogFile, 'utf8')) as { issue?: string };
    if (catalog.issue && !input.pinnedOpenapi) specProblems.push(catalog.issue);
  }
  gates.push({ id: 'openapi-preserved', status: input.fidelityMode === 'permissive' ? 'not-run' : specProblems.length ? 'fail' : 'pass', detail: specProblems.length ? specProblems.join('; ') : input.pinnedOpenapi ? 'all captured OpenAPI source and output documents match their pins' : 'no captured OpenAPI documents declared by acquisition', samples: specProblems.slice(0, 8), count: specProblems.length });
  if (input.fidelityMode === 'permissive') {
    for (const id of ['source-manifest-pinned', 'source-universe-accounted']) gates.push({ id, status: 'not-run', detail: 'permissive mode; source universe is not certified' });
  } else {
    try {
      const manifest = requireSourceManifest(input.workspace, input.pinnedSourceManifest);
      requireAcquisition(input.workspace, manifest, input.pinnedAcquisition, input.treePages);
      gates.push({ id: 'source-manifest-pinned', status: 'pass', detail: 'source manifest and frozen files match the discovery pin' });
      const problems = sourceUniverseProblems({ workspace: input.workspace, manifest, treePages: input.treePages, written: new Set(outByPath.keys()), quarantined: input.quarantinedPages });
      gates.push({ id: 'source-universe-accounted', status: problems.length ? 'fail' : 'pass', detail: problems.length ? `${problems.length} source universe problems` : `${manifest.pages.length} source identities accounted independently of the plan`, count: problems.length, samples: problems.slice(0, 8) });
    } catch (error) {
      const detail = (error as Error).message;
      if (!gates.some((gate) => gate.id === 'source-manifest-pinned')) gates.push({ id: 'source-manifest-pinned', status: 'fail', detail });
      gates.push({ id: 'source-universe-accounted', status: 'fail', detail });
    }
  }

  // 0. the reviewed plans still describe this output
  if (!input.pinnedPlans) {
    gates.push({ id: 'plans-pinned', status: 'not-run', detail: 'no plan hashes were pinned at convert; the output cannot be tied to reviewed decisions' });
  } else {
    const pinned = input.pinnedPlans;
    const planFile = (name: string) => join(input.workspace, 'plan', name);
    const hashOf = (path: string): string | undefined => (existsSync(path) ? sha256(readFileSync(path)) : undefined);
    const changed: string[] = ([
      ['component-plan.yaml', pinned.componentPlan],
      ['urls.yaml', pinned.urlPlan],
      ['assets.yaml', pinned.assetPlan],
    ] as Array<[string, string | undefined]>).filter(([file, expected]) => !expected || hashOf(planFile(file)) !== expected).map(([file]) => file);
    // Block exclusions are pinned by absence too: a file that appears after convert is a change.
    if (hashOf(planFile('block-exclusions.yaml')) !== pinned.blockExclusions) changed.push('block-exclusions.yaml');
    if (hashOf(planFile('scope-decisions.yaml')) !== pinned.scopeDecisions) changed.push('scope-decisions.yaml');
    gates.push({ id: 'plans-pinned', status: changed.length ? 'fail' : 'pass', detail: changed.length ? `plan changed after conversion: ${changed.join(', ')}; rerun convert` : 'component, URL and asset plans match the converted snapshot', count: changed.length, samples: changed });
  }

  // 1. pages accounted
  const scoped = input.treePages.filter((p) => p.migrate);
  const unaccounted = scoped.filter((p) => !(p.newPath && outByPath.has(p.newPath)) && !input.quarantinedPages.has(p.id) && !input.excludedPages.has(p.id));
  gates.push({ id: 'pages-accounted', status: unaccounted.length ? 'fail' : 'pass', detail: `${scoped.length - unaccounted.length}/${scoped.length} scoped pages converted, excluded or quarantined`, count: unaccounted.length, samples: unaccounted.slice(0, 5).map((p) => p.id) });

  // 2. ledger coverage
  const ids: Array<{ pageId: string; nodeId: string }> = [];
  const sourceBlocks = new Map<string, Block>();
  /** Nodes inside a chrome element: a rule that drops the element drops them with it. */
  const chromeContent = new Set<string>();
  for (const { doc } of input.sourceDocs) walkBlocks(doc.children, (n) => {
    ids.push({ pageId: doc.pageId, nodeId: n.id }); sourceBlocks.set(`${doc.pageId}:${n.id}`, n);
    if (n.type === 'component' && isHtmlChromeNode(n)) walkBlocks(n.children, (inner) => { chromeContent.add(`${doc.pageId}:${inner.id}`); });
  });
  const dispositions = Ledger.read(input.workspace);
  const summary: LedgerSummary = summarize(dispositions, ids);
  gates.push({ id: 'block-dispositions', status: summary.missing.length ? 'fail' : 'pass', detail: `${summary.covered}/${summary.totalSource} source blocks have a disposition (identical ${summary.identical}, transformed ${summary.transformed}, excluded ${summary.excluded}, quarantined ${summary.quarantined})`, count: summary.missing.length, samples: summary.missing.slice(0, 5).map((m) => m.sourceNodeId) });
  gates.push({ id: 'exclusions-attributed', status: summary.excludedUnattributed ? 'fail' : 'pass', detail: `${summary.excludedUnattributed} exclusions without reviewer`, count: summary.excludedUnattributed });

  // Exact is the release default; only an explicitly permissive session skips the exact family.
  const exact = (input.fidelityMode ?? 'exact') === 'exact';
  // A rule may drop script and style elements, which carry nothing the author wrote; any other exclusion, whoever made it, removes authored content.
  const exclusions = effectiveExclusions(dispositions, ids);
  const authoredExclusions = exclusions.filter((d) => !(d.reviewer !== undefined && RULE_REVIEWER.test(d.reviewer) && (isHtmlChromeNode(sourceBlocks.get(`${d.pageId}:${d.sourceNodeId}`)) || chromeContent.has(`${d.pageId}:${d.sourceNodeId}`))));
  gates.push({
    id: 'no-authored-exclusions',
    status: !exact ? 'not-run' : authoredExclusions.length ? 'fail' : 'pass',
    detail: exact ? `${authoredExclusions.length} authored blocks excluded (${exclusions.length - authoredExclusions.length} script/style nodes dropped by rule); exact mode permits none` : 'permissive mode; exclusions remain attributed in the ledger',
    count: exact ? authoredExclusions.length : 0,
    samples: authoredExclusions.slice(0, 5).map((d) => `${d.pageId}:${d.sourceNodeId} excluded by ${d.reviewer ?? 'nobody'}: ${d.reason}`),
  });

  const fidelity = readFidelityRecords(input.workspace);
  const convertedRecords = fidelity.filter(isConvertedFidelityRecord);
  const conversionFailures = exact ? convertedRecords.filter((record) => !record.pass) : [];
  // a held or out-of-scope page carries a pass:null record; only a page convert never recorded at all is missing
  const recorded = new Set(fidelity.map((record) => record.pageId));
  const missingFidelity: Array<{ doc: DocIR }> = [];
  if (exact) for (const entry of input.sourceDocs) if (!recorded.has(entry.doc.pageId)) missingFidelity.push(entry);
  gates.push({
    id: 'conversion-fidelity',
    status: !exact ? 'not-run' : conversionFailures.length || missingFidelity.length ? 'fail' : 'pass',
    detail: exact ? `${conversionFailures.length} pages changed during component conversion; ${missingFidelity.length} pages lack a fidelity record; ${fidelity.length - convertedRecords.length} pages held or not migrated` : 'permissive mode; exact conversion comparison is disabled',
    count: conversionFailures.length + missingFidelity.length,
    samples: [...conversionFailures.slice(0, 5).map((record) => `${record.source}: ${record.difference ?? 'changed'}`), ...missingFidelity.slice(0, 5).map(({ doc }) => `${doc.source}: missing fidelity record`)].slice(0, 5),
  });

  let serializationFailures = 0; const serializationSamples: string[] = [];
  if (exact) for (const record of convertedRecords.filter((entry) => entry.pass)) {
    const page = input.treePages.find((entry) => entry.id === record.pageId);
    const outputFile = page?.newPath ? outByPath.get(page.newPath) : undefined;
    if (!outputFile) { serializationFailures++; if (serializationSamples.length < 5) serializationSamples.push(`${record.source}: output missing`); continue; }
    try {
      const parsed = markdownToIr(readFileSync(outputFile, 'utf8'), { platform: 'dai', file: outputFile, pageId: record.pageId });
      const actual = renderedDocSnapshot(parsed);
      if (!fidelityEqual(record.expectedOutput, actual)) { serializationFailures++; if (serializationSamples.length < 5) serializationSamples.push(`${record.source}: ${firstFidelityDifference(record.expectedOutput, actual) ?? 'changed'}`); }
    } catch (error) {
      serializationFailures++; if (serializationSamples.length < 5) serializationSamples.push(`${record.source}: ${(error as Error).message}`);
    }
  }
  gates.push({ id: 'serialized-output-exact', status: !exact ? 'not-run' : serializationFailures ? 'fail' : 'pass', detail: exact ? `${serializationFailures} target MDX files differ from the resolved IR` : 'permissive mode; exact serialization comparison is disabled', count: serializationFailures, samples: serializationSamples });

  // Unsafe URL-bearing nodes are stripped by the serializer, but the loss must
  // remain a blocking, visible decision instead of silently shipping.
  let unsafeUrls = 0; const unsafeSamples: string[] = [];
  const inspectInline = (pageId: string, nodes: import('../ir/types.js').Inline[]) => {
    for (const n of nodes) {
      if (n.type === 'link' && !isSafeUrl(n.url, 'link')) { unsafeUrls++; if (unsafeSamples.length < 5) unsafeSamples.push(`${pageId}: ${n.url.slice(0, 80)}`); }
      else if (n.type === 'image' && !isSafeUrl(n.url, 'resource')) { unsafeUrls++; if (unsafeSamples.length < 5) unsafeSamples.push(`${pageId}: ${n.url.slice(0, 80)}`); }
      if ('children' in n) inspectInline(pageId, n.children as import('../ir/types.js').Inline[]);
    }
  };
  for (const { doc } of input.sourceDocs) walkBlocks(doc.children, (b) => {
    if (b.type === 'paragraph' || b.type === 'heading') inspectInline(doc.pageId, b.children);
    else if (b.type === 'image' && !isSafeUrl(b.url, 'resource')) { unsafeUrls++; if (unsafeSamples.length < 5) unsafeSamples.push(`${doc.pageId}: ${b.url.slice(0, 80)}`); }
    else if (b.type === 'figure' && !isSafeUrl(b.image.url, 'resource')) { unsafeUrls++; if (unsafeSamples.length < 5) unsafeSamples.push(`${doc.pageId}: ${b.image.url.slice(0, 80)}`); }
    else if (b.type === 'table') for (const row of b.children) for (const cell of row.children) inspectInline(doc.pageId, cell.children);
  });
  gates.push({ id: 'no-unsafe-urls', status: unsafeUrls ? 'fail' : 'pass', detail: `${unsafeUrls} unsafe link or asset URLs were stripped`, count: unsafeUrls, samples: unsafeSamples });

  const assets = readManifest(input.workspace);
  const unresolvedAssets = Object.values(assets.entries).filter((e) => e.status === 'failed' || (assets.provider !== 'none' && (e.status === 'kept-external' || !e.finalUrl)));
  gates.push({ id: 'assets-ready', status: unresolvedAssets.length ? 'fail' : 'pass', detail: assets.provider === 'none' ? `${Object.values(assets.entries).filter((e) => e.status === 'kept-external').length} assets intentionally remain on source hosts (provider none)` : `${unresolvedAssets.length} assets failed, remain external, or lack a final ingested URL`, count: unresolvedAssets.length, samples: unresolvedAssets.slice(0, 5).flatMap((e) => e.sourceUrls.slice(0, 1)) });

  // 3. prose match + code blocks + tables
  // A block the ledger records as excluded was removed by a reviewed decision, so it is not prose the
  // conversion lost; `effectiveExclusions` already covers the whole excluded subtree.
  const excludedByPage = new Map<string, Set<string>>();
  for (const d of exclusions) {
    let page = excludedByPage.get(d.pageId);
    if (!page) { page = new Set(); excludedByPage.set(d.pageId, page); }
    page.add(d.sourceNodeId);
  }
  let unmatched = 0; const unmatchedSamples: string[] = [];
  let codeMismatch = 0; const codeSamples: string[] = [];
  let tableMismatch = 0; const tableSamples: string[] = [];
  for (const { doc, outputFile } of input.sourceDocs) {
    if (!outputFile || !existsSync(outputFile)) continue;
    const mdx = readFileSync(outputFile, 'utf8');
    const hay = normaliseMdxText(mdx);
    for (const seg of proseSegments(doc, excludedByPage.get(doc.pageId))) if (!hay.includes(seg)) { unmatched++; if (unmatchedSamples.length < 5) unmatchedSamples.push(`${doc.source}: "${seg.slice(0, 60)}"`); }
    const src = codeBlocks(doc); const out = new Set(mdxCodeBlocks(mdx));
    for (const c of src) if (!out.has(c)) { codeMismatch++; if (codeSamples.length < 5) codeSamples.push(`${doc.source}: ${c.slice(0, 40)}`); }
    const outputTables = mdxTableSignatures(mdx);
    for (const signature of tableSignatures(doc)) {
      const match = outputTables.indexOf(signature);
      if (match >= 0) outputTables.splice(match, 1);
      else { tableMismatch++; if (tableSamples.length < 5) tableSamples.push(doc.source); }
    }
  }
  gates.push({ id: 'prose-match', status: unmatched ? 'fail' : 'pass', detail: `${unmatched} normalised prose segments not found in output`, count: unmatched, samples: unmatchedSamples });
  let outlineMismatch = 0; const outlineSamples: string[] = [];
  for (const { doc, outputFile } of input.sourceDocs) {
    if (!outputFile || !existsSync(outputFile)) continue;
    const src = headingOutline(doc); const out = mdxHeadingOutline(readFileSync(outputFile, 'utf8'));
    if (src.join('\n') !== out.join('\n')) { outlineMismatch++; if (outlineSamples.length < 5) outlineSamples.push(`${doc.source}: source [${src.slice(0, 4).join(' | ')}] vs output [${out.slice(0, 4).join(' | ')}]`); }
  }
  gates.push({ id: 'headings-sequence', status: outlineMismatch ? 'fail' : 'pass', detail: `${outlineMismatch} pages whose heading outline (levels and order) changed`, count: outlineMismatch, samples: outlineSamples });
  gates.push({ id: 'code-blocks-exact', status: codeMismatch ? 'fail' : 'pass', detail: `${codeMismatch} code blocks changed`, count: codeMismatch, samples: codeSamples });
  gates.push({ id: 'tables-exact', status: tableMismatch ? 'fail' : 'pass', detail: `${tableMismatch} source table cell matrices changed`, count: tableMismatch, samples: tableSamples });

  // 4. strict validator on every output file
  let errors = 0; const errSamples: string[] = [];
  for (const f of outMdx) for (const i of validateMdx(readFileSync(f, 'utf8'))) if (i.severity === 'error') { errors++; if (errSamples.length < 8) errSamples.push(`${relative(input.outputDir, f)}:${i.line ?? '-'} ${i.code}: ${i.message}`); }
  // the platform compiles each file whole, frontmatter included, so each must parse that way too
  for (const f of outMdx) {
    try {
      fromMarkdown(readFileSync(f, 'utf8'), { extensions: [gfm(), mdxjs()], mdastExtensions: [gfmFromMarkdown(), mdxFromMarkdown()] });
    } catch (error) {
      errors++;
      if (errSamples.length < 8) errSamples.push(`${relative(input.outputDir, f)}: whole-file MDX parse: ${String((error as Error).message).split('\n')[0]}`);
    }
  }
  gates.push({ id: 'contract-valid', status: errors ? 'fail' : 'pass', detail: `${errors} strict-validator errors across ${outMdx.length} files`, count: errors, samples: errSamples });

  // 4b. the raw source, re-read: the only checks that can see a loss which happened before the snapshot
  const evidence = input.sourceEvidence;
  // What this source kind can be held to. A proof with no witness in this source is reported with
  // the reason, never failed and never silently skipped; every kind keeps at least one witness.
  const inapplicable = inapplicableProofs({ kind: input.sourceKind ?? 'url', publishesMarkdown: !!evidence?.profile?.mdSuffix });
  const sourceGate = (id: string, results: SourceComparison[], summary: (failures: SourceComparison[]) => string): void => {
    if (!exact) { gates.push({ id, status: 'not-run', detail: 'permissive mode; the source is not re-read' }); return; }
    // Missing evidence always fails: a proof is excused only when this source kind could never
    // have produced the witness, never because the witness is absent.
    if (!evidence) { gates.push({ id, status: 'fail', detail: 'no raw source evidence was supplied; exact mode certifies output only against the acquired source' }); return; }
    const inapplicableReason = inapplicable.get(id);
    if (inapplicableReason) { gates.push({ id, status: 'inapplicable', detail: inapplicableReason }); return; }
    const requiredIds = input.treePages.filter((page) => page.migrate).map((page) => page.id);
    const resultIds = new Set(results.map((result) => result.pageId));
    if (!results.length || resultIds.size !== results.length || requiredIds.some((id) => !resultIds.has(id))) {
      gates.push({ id, status: 'fail', detail: 'raw source evidence is empty, duplicated, or missing migrated pages' }); return;
    }
    const failures = results.filter((result) => !result.pass);
    gates.push({
      id,
      status: failures.length ? 'fail' : 'pass',
      detail: failures.length ? summary(failures) : `${results.length} page(s) match the acquired source`,
      count: failures.length,
      samples: failures.slice(0, 5).map((failure) => `${failure.path}: ${failure.difference ?? failure.detail ?? 'differs'}`),
    });
  };
  const sourcePages = exact && evidence ? evidence.pages : [];
  sourceGate('source-content-exact', sourcePages.map((page) => sourceContentExact(page, evidence!.platform, evidence!.profile, evidence!.links, evidence!.assets, evidence!.declaredLosses)), (failures) => `${failures.length} page(s) differ from the published source`);
  sourceGate('source-metadata-exact', sourcePages.map((page) => sourceMetadataExact(page, evidence?.platform ?? 'generic', evidence?.profile)), (failures) => `${failures.length} page(s) carry a title or description the source does not state`);
  sourceGate('html-reconciliation', evidence?.profile ? sourcePages.map((page) => htmlReconciliation(page, evidence.platform, evidence.profile!)) : sourcePages.map((page) => ({ pageId: page.pageId, path: page.path, pass: false, detail: `profile ${evidence?.platform ?? 'unknown'} declares no rendered-page selectors to reconcile against` })), (failures) => `${failures.length} page(s) disagree with the rendered source`);
  sourceGate('chrome-absent', sourcePages.map((page) => chromeAbsent(page, evidence?.profile?.chromeStrings ?? [])), (failures) => `${failures.length} page(s) contain platform chrome`);

  // 5. navigation
  const navFile = join(input.outputDir, 'documentation.json');
  if (existsSync(navFile)) {
    const nav = JSON.parse(readFileSync(navFile, 'utf8'));
    const navIssues = validateNavigation(nav, (p) => outByPath.has(p.replace(/^\//, '')));
    gates.push({ id: 'navigation-valid', status: navIssues.length ? 'fail' : 'pass', detail: `${navIssues.length} navigation issues`, count: navIssues.length, samples: navIssues.slice(0, 5).map((i) => i.message) });
    const sortValue = (value: unknown): unknown => value && typeof value === 'object'
      ? Array.isArray(value) ? value.map(sortValue) : Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]))
      : value;
    const canonical = (value: unknown): string => JSON.stringify(sortValue(value));
    // The reviewed tree and, when the source can be re-read, a fresh extraction from the frozen
    // source. Comparing only against the tree the same run produced proves nothing, so a mismatch
    // with the re-extraction fails even when the tree agrees.
    const written = canonical((nav as Record<string, unknown>).navigation);
    const expected = input.expectedNavigation;
    const matchesTree = !!expected && written === canonical(expected);
    const reExtracted = evidence?.navigation;
    const matchesSource = !!reExtracted && written === canonical(reExtracted);
    // A manual tree is itself an explicit source-structure decision pinned by human gate 1. It
    // exists precisely when executable source configuration cannot be re-read safely, so requiring
    // a second machine witness here would make the documented manual recovery path impossible.
    const manual = input.navigationSource === 'manual';
    const same = matchesTree && (manual || matchesSource);
    const why = !expected ? 'expected navigation was not supplied'
      : !matchesTree ? 'output navigation differs from the reviewed source tree'
      : manual ? 'output navigation matches the human-reviewed tree pinned by gate 1'
      : !reExtracted ? 'no independently extracted source navigation was supplied'
      : !matchesSource ? `output navigation differs from the navigation re-extracted from the acquired source (${evidence?.navigationSource ?? 'source'})`
      : reExtracted ? `output navigation matches the reviewed tree and the navigation re-extracted from the acquired source (${evidence?.navigationSource ?? 'source'})`
      : 'output navigation exactly matches the reviewed source tree';
    gates.push({ id: 'navigation-exact', status: !exact ? 'not-run' : same ? 'pass' : 'fail', detail: exact ? why : 'permissive mode; exact navigation comparison is disabled', count: exact && !same ? 1 : 0 });
  } else gates.push({ id: 'navigation-valid', status: 'fail', detail: 'documentation.json missing' });
  if (!existsSync(navFile)) gates.push({ id: 'navigation-exact', status: exact ? 'fail' : 'not-run', detail: exact ? 'documentation.json missing' : 'permissive mode; exact navigation comparison is disabled' });
  // Every source kind must state its navigation, not have it inferred. A generic repository's
  // groups come from directory names, which is the same inference as a URL path and was previously
  // exempted wholesale for any non-URL source.
  const navigationProven = ['source-config', 'platform-metadata', 'dom-sidebar', 'manual'].includes(input.navigationSource ?? '');
  gates.push({ id: 'source-navigation-proven', status: !exact ? 'not-run' : navigationProven ? 'pass' : 'fail', detail: !exact ? 'permissive mode; navigation provenance is not certified' : navigationProven ? `navigation source: ${input.navigationSource}` : `navigation was inferred from ${input.navigationSource ?? 'nothing the source states'}; exact mode requires the source's own configuration, platform metadata, a rendered sidebar, or a navigation tree an operator reviewed`, count: exact && !navigationProven ? 1 : 0 });

  // Parse the written documents once and inspect their semantic link nodes. Regexes miss
  // component links and page-relative targets, exactly the links most likely to break after restructuring.
  const outputLinks = new Map<string, string[]>();
  /** What each written page offers a deep link, by route: its headings and any id written into it. */
  const outputAnchors = new Map<string, Set<string>>();
  for (const f of outMdx) {
    try {
      const route = relative(input.outputDir, f).replace(/\.mdx?$/, '');
      const text = readFileSync(f, 'utf8');
      const parsed = markdownToIr(text, { platform: 'dai', file: route, pageId: route });
      outputLinks.set(f, documentLinks(parsed));
      outputAnchors.set(route, documentAnchors(parsed, text, (spec) => (existsSync(join(input.outputDir, spec)) ? readFileSync(join(input.outputDir, spec), 'utf8') : undefined)));
    } catch {
      // contract-valid already blocks a file that cannot be parsed; do not manufacture a second diagnosis here
      outputLinks.set(f, []);
    }
  }
  /** Deployed route a root- or page-relative output link resolves to; undefined for anchors, queries and external schemes. */
  const outputRoute = (url: string, from: string): string | undefined => {
    if (!url || url.startsWith('#') || url.startsWith('?') || url.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return undefined;
    try {
      const base = `https://target.invalid/${from.replace(/^\/+/, '')}`;
      const path = decodeURI(new URL(url, base).pathname).replace(/\/+$/, '').replace(/^\/+/, '');
      return path || 'index';
    } catch { return '__invalid_url__'; }
  };

  // 6. internal links resolve
  let broken = 0; const brokenSamples: string[] = [];
  for (const f of outMdx) {
    const from = relative(input.outputDir, f).replace(/\.mdx?$/, '');
    for (const url of outputLinks.get(f) ?? []) {
      const target = outputRoute(url, from);
      if (target && !outByPath.has(target)) { broken++; if (brokenSamples.length < 5) brokenSamples.push(`${relative(input.outputDir, f)} → ${url}`); }
    }
  }
  gates.push({ id: 'internal-links', status: broken ? 'fail' : 'pass', detail: `${broken} internal links do not resolve to an output page`, count: broken, samples: brokenSamples });

  // 6a. a deep link must land where it says: a fragment naming an anchor the page does not have
  // loads the page at the top and reports nothing, and until now that was only caught on a preview.
  const fragmentLinks = new Map<string, string[]>();
  for (const [file, urls] of outputLinks) fragmentLinks.set(relative(input.outputDir, file).replace(/\.mdx?$/, ''), urls);
  const fragmentProblems = unresolvedFragments(fragmentLinks, outputAnchors, outputRoute);
  // A link the source site had already broken is not a loss this migration caused, and exact mode
  // cannot invent the anchor it names. Those are reported for the customer to fix in their own
  // content; anything the source did offer and the output does not still blocks.
  const sourceAnchorsByRoute = new Map<string, ReadonlySet<string>>();
  for (const page of sourcePages) if (page.html) sourceAnchorsByRoute.set(page.route.replace(/^\/+/, ''), htmlAnchors(page.html));
  const { broken: fragmentsBroken, inherited: fragmentsInherited } = splitInheritedFragments(fragmentProblems, sourceAnchorsByRoute);
  if (fragmentsInherited.length) {
    mkdirSync(join(input.workspace, 'report'), { recursive: true });
    writeFileSync(join(input.workspace, 'report', 'inherited-broken-links.json'), JSON.stringify(fragmentsInherited, null, 2), { mode: 0o600 });
  }
  gates.push({
    id: 'fragments-resolve',
    status: fragmentsBroken.length ? 'fail' : 'pass',
    detail: fragmentsBroken.length
      ? `${fragmentsBroken.length} link(s) point at an anchor the target page does not have`
      : `every deep link lands on an anchor the target page has${fragmentsInherited.length ? `; ${fragmentsInherited.length} link(s) were already broken on the source site and are reported in report/inherited-broken-links.json` : ''}`,
    count: fragmentsBroken.length,
    samples: fragmentsBroken.slice(0, 6).map((problem) => `${problem.from} → ${problem.link}: ${problem.reason}`),
  });

  // 6b. links that leave the migrated site for the source site, which usually moves to Documentation.AI
  const unmigratedMode = readUrlPlan(input.workspace)?.unmigratedLinks ?? 'keep';
  const sourceHosts = new Set(input.sourceEvidence?.links?.hosts ?? []);
  let unmigrated = 0; const unmigratedSamples: string[] = [];
  if (sourceHosts.size) {
    for (const f of outMdx) {
      for (const url of outputLinks.get(f) ?? []) {
        let host: string | undefined;
        try { host = new URL(url).hostname; } catch { host = undefined; }
        if (!host || !sourceHosts.has(host)) continue;
        unmigrated++;
        if (unmigratedSamples.length < 5) unmigratedSamples.push(`${relative(input.outputDir, f)} → ${url}`);
      }
    }
  }
  gates.push({
    id: 'unmigrated-links',
    status: unmigrated && unmigratedMode === 'keep' ? 'fail' : 'pass',
    detail: !unmigrated ? 'no link points at the source site'
      : unmigratedMode === 'source' ? `${unmigrated} links point at the source site, which plan/urls.yaml (unmigratedLinks: source) says stays up; listed in report/unmigrated-links.json`
      : `${unmigrated} links point at the source site, which usually moves to Documentation.AI: migrate their pages, fix the links, or set unmigratedLinks: source in plan/urls.yaml if the source site stays up (listed in report/unmigrated-links.json)`,
    count: unmigrated, samples: unmigratedSamples,
  });

  // 7. unresolved snippets / quarantine placeholders in output
  let unresolved = 0; const unresolvedSamples: string[] = [];
  for (const f of outMdx) { const n = (readFileSync(f, 'utf8').match(/UNRESOLVED SNIPPET|QUARANTINED:|UNSUPPORTED (?:INLINE COMPONENT|EXPRESSION)/g) ?? []).length; if (n) { unresolved += n; if (unresolvedSamples.length < 5) unresolvedSamples.push(relative(input.outputDir, f)); } }
  gates.push({ id: 'no-unresolved-blocks', status: unresolved ? 'fail' : 'pass', detail: `${unresolved} unresolved snippet, component, expression, or quarantine placeholders remain in output`, count: unresolved, samples: unresolvedSamples });

  // 8. redirects
  const plan = readUrlPlan(input.workspace);
  if (plan) {
    const r = redirectMaps(plan);
    // The rules are also read as a graph: a set of individually valid rules can still loop, chain,
    // claim one old path twice, or land on a page nobody wrote.
    const graph = redirectProblems([...r.exact, ...r.wildcard], new Set(outByPath.keys()));
    const issues = [...r.issues, ...graph.map((problem) => `${problem.kind}: ${problem.detail}`)];
    gates.push({ id: 'redirects-clean', status: issues.length ? 'fail' : 'pass', detail: `${r.exact.length} exact rules, ${r.wildcard.length} wildcard candidates, ${issues.length} issues`, count: issues.length, samples: issues.slice(0, 6) });
  }
  else gates.push({ id: 'redirects-clean', status: 'not-run', detail: 'no plan/urls.yaml' });

  // 9. unreviewed decisions
  gates.push({ id: 'no-unreviewed-decisions', status: input.unreviewed ? 'fail' : 'pass', detail: `${input.unreviewed} T5/T6/T7 clusters not reviewed`, count: input.unreviewed });

  // 10. determinism
  const hash = canonicalHash(input.outputDir);
  // compare convert against convert: the live output also contains nav artefacts written after convert
  const current = input.convertOutputHash ?? hash;
  if (input.previousCanonicalHash) gates.push({ id: 'deterministic-rerun', status: input.previousCanonicalHash === current ? 'pass' : 'fail', detail: `convert output ${current.slice(0, 12)} vs previous convert ${input.previousCanonicalHash.slice(0, 12)} over identical inputs` });
  else gates.push({ id: 'deterministic-rerun', status: 'not-run', detail: `no second convert over identical inputs yet; run convert again (hash ${hash.slice(0, 12)})` });

  // 11. preview-based gates
  if (input.previewUrl) {
    gates.push({ id: 'preview-contract-version', status: input.previewContractVersion === input.pinnedContractVersion ? 'pass' : 'fail', detail: `preview ${input.previewContractVersion ?? 'unknown'} vs pinned ${input.pinnedContractVersion}` });
    gates.push({ id: 'browser-fragments', status: 'not-run', detail: 'headless Chrome result is applied by the CLI after static gates' });
    gates.push({ id: 'browser-content', status: 'not-run', detail: 'headless Chrome result is applied by the CLI after static gates' });
    gates.push({ id: 'responsive-layout', status: 'not-run', detail: 'headless Chrome result is applied by the CLI after static gates' });
  } else {
    gates.push({ id: 'preview-contract-version', status: 'not-run', detail: 'no preview URL' });
    gates.push({ id: 'browser-fragments', status: 'not-run', detail: 'no preview URL' });
    gates.push({ id: 'browser-content', status: 'not-run', detail: 'no preview URL' });
    gates.push({ id: 'responsive-layout', status: 'not-run', detail: 'no preview URL' });
  }

  // 12. migrator provenance: the gates certify output of the build pinned at init, so verify must run from that same build
  gates.push(migratorPinnedGate(input.pinnedMigrator, input.currentMigrator));
  return gates;
}

function migratorPinnedGate(pinned: MigratorProvenance | undefined, current: MigratorProvenance | undefined): GateResult {
  if (!current) return { id: 'migrator-pinned', status: 'not-run', detail: 'current migrator provenance was not captured' };
  if (!pinned) return { id: 'migrator-pinned', status: 'fail', detail: 'session.json records no migrator provenance; re-run init with this migrator', count: 1 };
  const drift = migratorDrift(pinned, current);
  return {
    id: 'migrator-pinned',
    status: drift.length ? 'fail' : 'pass',
    detail: drift.length ? `migrator changed since init: ${drift.join('; ')}; re-run init and convert with one migrator build` : `migrator ${describeMigrator(pinned)}`,
    count: drift.length,
    samples: drift,
  };
}
