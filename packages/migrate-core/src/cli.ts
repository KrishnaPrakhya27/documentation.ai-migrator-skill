#!/usr/bin/env node
/**
 * dai-migrate: stage commands over an external workspace.
 *
 *   init → fingerprint → discover [human 1/4] → acquire → inventory → plan [human 2/4]
 *   → assets → convert ×2 → nav → verify [human 3/4] → push preview
 *   → verify preview [human 4/4] → report
 *
 * Every stage reads and writes files in the workspace; re-runs are safe.
 */
import { gitbookHeadingIds, mintlifyHeadingId } from './urls/slugger.js';

/** The anchor a link names, as the page spells it: `#split-configuration-with-%24ref` names `split-configuration-with-$ref`. */
function fragmentOf(url: string): string | undefined {
  const raw = url.split('#')[1];
  if (!raw) return undefined;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** A parse failure names the page it happened on: an operator with 1,255 pages cannot bisect one by line number alone. */
function named<T>(source: string, read: () => T): T {
  try { return read(); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(source)) throw error;
    throw new Error(`${source}: ${message}`);
  }
}

/** A heading's rendered words, badge text included: inline HTML contributes what a reader sees of it, not its tags. */
function anchorText(nodes: import('./ir/types.js').Inline[]): string {
  return nodes.map((n) => (n.type === 'inlineHtml' ? n.value.replace(/<[^<>]*>/g, '') : n.type === 'text' || n.type === 'inlineCode' ? n.value : 'children' in n ? anchorText(n.children) : '')).join('');
}
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { Cookie, CookieJar } from 'tough-cookie';
import { loadContract } from '@dai/content-contract';
import { freezeDirectory, frozenRootPath, narrowSourceManifest, sourceManifestPath, writeSourceManifest, type SourceManifest, type FreezeResult } from './evidence/manifest.js';
import { nativeSourceManifest, liveSourceManifest } from './evidence/capture.js';
import { requireSourceManifest } from './evidence/verify.js';
import { nativeNavigationWitness } from './evidence/native-navigation.js';
import { pinAcquisition, reanchorAcquisition, requireAcquisition } from './evidence/acquisition.js';
import { answeredHelpSystemIssues, ensureScopeDecisionsFile, excludeHelpSystems, readScopeDecisions, recordScopeExclusions, scopeDecisionsPath, type DiscoveredHelpSystem } from './evidence/scope.js';
import { captureSpecGraph, writeSpecOutput, type SpecManifest, specOutputPath } from './openapi/graph.js';
import { readmeCatalogSpecs } from './openapi/readme.js';
import { HELP, parseCommandLine } from './cli/options.js';
import { titleHeading } from './ir/page-title.js';
import { documentLinks } from './verify/source-truth.js';
import { progressReporter } from './cli/progress.js';
import { canonicalHostsPath, loadSnapshot, readJson, readSnapshotPage, resetDir, snapshotPageCount, snapshotPages, sourceFiles, writeJson } from './cli/io.js';
import { buildSourceEvidence, expectedSidebar, frozenNavigationData, siteLinksForWorkspace, writtenPagePaths } from './cli/evidence.js';
import { captureOpenapi, type OpenapiCapture } from './cli/openapi-capture.js';
import { attachHelpCenterHub, defaultHubPath, helpCenterHubMdx } from './nav/help-center.js';
import { mergeOperationDocuments, openapiAnchors, parameterLinkRewriter } from './ir/mintlify-openapi.js';
import type { OpenApiOperationFragment } from './ir/types.js';
import { buildCustomerReport } from './report/customer-data.js';
import { renderCustomerReportHtml } from './report/customer-html.js';
import { htmlToPdf, ChromeUnavailableError } from './report/pdf.js';
import { acquiredHtml, readPlatformMeta, type PlatformMeta } from './cli/platform-meta.js';
import { assertOutsidePlugin, ensureWorkspace, readSession, writeSession, markStage, type Session, fileHash, recordRevision } from './session/workspace.js';
import { acquireWorkspaceLock, type WorkspaceLock } from './session/lock.js';
import { newMigrationId, pageIdFromPlatform, sha256 } from './session/ids.js';
import { captureMigratorProvenance, describeMigrator, migratorDrift } from './session/provenance.js';
import { GATE_NAMES, gateSubjects, pinGateSubjects, releaseApprovalProblems } from './session/approvals.js';
import { countQuarantine, writeQuarantine } from './session/quarantine.js';
import { preflight, probePushAccess } from './session/preflight.js';
import { DaiClient, noDeploymentDiagnosis } from './session/platform.js';
import { fingerprint } from './scrape/fingerprint.js';
import { CanonicalHosts, Fetcher, type FetchOptions } from './scrape/fetcher.js';
import { Firecrawl, readFirecrawlPage, type FirecrawlOptions } from './scrape/firecrawl.js';
import { getProfile, htmlAdapterOptions, profileHostAliases, type ScrapeProfile } from './scrape/profiles.js';
import { discoverLiveSite, extractMintlifyNavigation, navigationFromFrozenPages, sidebarObserved, siteNameFromTitleTags, type DiscoveredNavigationNode, type DiscoveryResult } from './scrape/discovery.js';
import { defaultUrlFromHelpSystem, helpSystemRoot } from './scrape/madcap-toc.js';
import { unwrapPublishedMarkdown } from './scrape/published-markdown.js';
import { extractSeo, seoFrontmatter } from './scrape/seo.js';
import { acquirePages, acquireFirecrawlPages, acquiredPath, type AcquiredPage } from './scrape/acquire.js';
import { acquireNativePages } from './scrape/native-acquire.js';
import { htmlToIr } from './ir/from-html.js';
import { markdownToIr } from './ir/from-markdown.js';
import { extractIfZip, readD360Export, d360ArticleToIr, type D360Export } from './adapters/document360.js';
import { adapterFor } from './adapters/registry.js';
import { readMintlifyRepo, mintlifySnippetResolver } from './adapters/mintlify.js';
import { readGitbookRepo } from './adapters/gitbook.js';
import { readReadmeRepo, ReadmeApi, readmeApiTree } from './adapters/readme.js';
import { scanComponentDefinitions, attachDefinitions } from './adapters/definitions.js';
import { writeTree, readTree, buildDocumentationNavigation, pagesWithoutPlacement, placedPageIds, type GroupOpenapiRef, type SourceNavigationNode, type Tree, type TreePage } from './nav/tree.js';
import { documentationSiteSettings, withoutSourceBranding } from './nav/site-settings.js';
import { defaultUrlPlan, extendUrlPlan, writeUrlPlan, readUrlPlan, applyUrlPlan, redirectMaps, anchorMap, type RedirectRule } from './urls/plan.js';
import { retargetDocLinks, siteLinkResolver, siteLinkTarget, siteLinksFor, type SiteLinks } from './urls/site-links.js';
import { RulesEngine, applyDeclaredLosses, loadMappings, collectComponents, planEntryIsDecided, type ComponentPlanEntry } from './components/rules-engine.js';
import { clusterComponents, type ClusterEntry } from './components/signature.js';
import { Ledger } from './ledger/dispositions.js';
import { DecisionLog } from './log/decisions.js';
import { redact } from './log/redact.js';
import { docToMdx } from './ir/to-dai-mdx.js';
import type { DocIR } from './ir/types.js';
import { walkBlocks, inlineText, type Block } from './ir/types.js';
import { applyBlockExclusions, assertExclusionsPermitted, blockExclusionsPath, readBlockExclusions, unmatchedBlockExclusions } from './ir/exclusions.js';
import { describeUnreadableDimension, unreadableImageDimensions } from './ir/dimensions.js';
import { readManifest, referenceTally, rewriteAssetRefs, d360MediaResolver } from './assets/manifest.js';
import { s3StorageFromEnv, s3StorageProblems, type AssetProviderOptions } from './assets/providers.js';
import { assertAssetsHosted, runAssetsStage, UnhostedAssetsError, type AssetsStageResult } from './assets/stage.js';
import { runGates, canonicalHash, gateSatisfied, previewPushBlockers, releaseBlockers, waivedExactnessGates, type GateResult, type SourceEvidence } from './verify/gates.js';
import { loadRawSourcePages, rawSourceIr, type RawSourcePage } from './verify/source-truth.js';
import { routeUrl, runBrowserContentGate, runBrowserFragmentGate, type BrowserAnchor, type ExpectedNavigationEntry } from './verify/browser.js';
import { cachedRenderer, openChromeSession, EXPAND_INTERACTIVE } from './verify/chrome-session.js';
import { runResponsiveGate } from './verify/responsive.js';
import { authoredContentSnapshot, fidelityEqual, firstFidelityDifference, renderedDocSnapshot } from './verify/fidelity.js';
import { unconvertedFidelityRecord, writeFidelityRecords, type FidelityRecord } from './verify/fidelity-records.js';
import { writeMigrationBranch } from './write/migration-branch.js';
import { writeGates, writeReviewQueue, writeSummary, writePlatformGaps, readDecisions, writeConnectionSummary, type RunProvenance } from './report/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(here, '..', '..', '..');
const CORE_VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version as string;


const { values: v, positionals } = parseCommandLine();

const cmd = positionals[0];
if (!cmd || v.help) { console.log(HELP); process.exit(0); }

function ws(): string {
  if (!v.workspace) throw new Error('--workspace is required (or MIGRATION_WORKSPACE)');
  return resolve(v.workspace);
}
function fail(msg: string): never { console.error(`✖ ${redact(msg)}`); process.exit(1); }
function ok(msg: string) { console.log(`✔ ${msg}`); }
function humanGate(number: 1 | 2 | 3 | 4, name: string, review: string): void {
  console.log(`⏸ HUMAN GATE ${number}/4 — ${name}: ${review}`);
  console.log(`   record the decision with: dai-migrate approve --gate ${number} --by "<who approved it>"`);
}
function readSensitive(path: string): string {
  const resolved = resolve(path);
  const mode = statSync(resolved).mode & 0o777;
  if (mode & 0o077) fail(`secret file ${resolved} must not be readable by group or others (chmod 600)`);
  return readFileSync(resolved, 'utf8');
}
function requestHeaders(): Record<string, string> | undefined {
  if (!v['headers-file']) return undefined;
  const parsed = JSON.parse(readSensitive(v['headers-file'])) as Record<string, unknown>;
  const blocked = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (blocked.has(key.toLowerCase())) fail(`header ${key} cannot be overridden`);
    if (typeof value !== 'string') fail(`header ${key} must have a string value`);
    headers[key] = value;
  }
  return headers;
}
function requestCookieJar(): CookieJar | undefined {
  if (!v['cookies-file']) return undefined;
  const raw = readSensitive(v['cookies-file']).trim();
  if (!raw) return new CookieJar();
  if (raw.startsWith('{')) return CookieJar.deserializeSync(JSON.parse(raw));
  const jar = new CookieJar();
  for (const original of raw.split(/\r?\n/)) {
    const line = original.startsWith('#HttpOnly_') ? original.slice('#HttpOnly_'.length) : original;
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 7) fail(`invalid Netscape cookie line in ${v['cookies-file']}`);
    const [domainRaw, , cookiePath, secureRaw, expiresRaw, name, ...valueParts] = fields;
    const domain = domainRaw.replace(/^\./, '');
    const cookie = new Cookie({ key: name, value: valueParts.join('\t'), domain, path: cookiePath || '/', secure: secureRaw.toUpperCase() === 'TRUE', expires: expiresRaw === '0' ? 'Infinity' : new Date(Number(expiresRaw) * 1000) });
    jar.setCookieSync(cookie, `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path}`);
  }
  return jar;
}
function networkOptions(workspace: string, session: Session, allowHosts?: string[]): FetchOptions {
  const sourceOrigin = /^https?:\/\//.test(session.source.location) ? new URL(session.source.location).origin : undefined;
  const extraOrigins = (v['auth-origin'] ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => new URL(x).origin);
  const credentialOrigins = [...new Set([sourceOrigin, ...extraOrigins].filter((x): x is string => !!x))];
  const rps = Number(v.rps);
  if (!Number.isFinite(rps) || rps <= 0) fail('--rps must be a positive finite number');
  return { workspace, rps, customerAuthorised: session.customerAuthorisedCrawl, allowHosts, proxy: v.proxy, headers: requestHeaders(), cookieJar: requestCookieJar(), credentialOrigins };
}
async function firecrawlOptions(workspace: string, session: Session, targetUrl: string): Promise<FirecrawlOptions> {
  const net = networkOptions(workspace, session, [new URL(targetUrl).hostname]);
  const headers = { ...(net.headers ?? {}) };
  const cookie = await net.cookieJar?.getCookieString(targetUrl);
  if (cookie) headers.cookie = cookie;
  const proxy = v['firecrawl-proxy'];
  if (proxy !== 'basic' && proxy !== 'enhanced' && proxy !== 'auto') fail('--firecrawl-proxy must be basic, enhanced, or auto');
  const maxConcurrency = Number(v['max-concurrency'] ?? v.concurrency);
  if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 100)) fail('--max-concurrency must be an integer from 1 to 100');
  return { apiKey: process.env.FIRECRAWL_API_KEY!, workspace, proxy: proxy as FirecrawlOptions['proxy'], maxConcurrency, timeoutMinutes: Number(v['firecrawl-timeout-min']), retainBodies: false, zeroDataRetention: !!v['zero-data-retention'], headers: Object.keys(headers).length ? headers : undefined };
}
/** The capture the operator asked for, reported as the stage's own progress line. */
async function captureOpenapiFor(workspace: string, session: Session, tree: Tree): Promise<OpenapiCapture> {
  const capture = await captureOpenapi({ workspace, session, tree, supplied: v.openapi ?? [], concurrency: Number(v.concurrency), fetcher: new Fetcher(networkOptions(workspace, session)) });
  if (capture.documents) ok(`${capture.documents} OpenAPI documents captured without flattening; ${capture.operations} operations indexed`);
  return capture;
}

function requireStages(session: Session, ...stages: string[]): void {
  const missing = stages.filter((stage) => session.stages[stage]?.status !== 'done');
  if (missing.length) fail(`required stage(s) not complete: ${missing.join(', ')}`);
}
function requireFrozenInputs(workspace: string, session: Session): SourceManifest {
  const manifest = requireSourceManifest(workspace, session.hashes.sourceManifest);
  requireAcquisition(workspace, manifest, session.hashes.acquisition, readTree(workspace).pages);
  return manifest;
}

/** Replace inline snippet placeholders with provided bodies (plain inline text) when the operator supplied them. */
function inlineSnippetBodies(doc: DocIR, snippets: Array<{ token: string; body: string | null }>): DocIR {
  const bodies = new Map(snippets.filter((s) => s.body).map((s) => [s.token, s.body as string]));
  if (!bodies.size) return doc;
  const fix = (nodes: any[]): any[] => nodes.map((n) => {
    if (n.type === 'inlineHtml' && typeof n.value === 'string') {
      const m = n.value.match(/^\{\/\* UNRESOLVED SNIPPET (.+?) \*\/\}$/);
      if (m && bodies.has(m[1])) return { id: n.id, type: 'text', value: bodies.get(m[1]) };
    }
    if (Array.isArray(n.children)) return { ...n, children: fix(n.children) };
    return n;
  });
  return { ...doc, children: fix(doc.children) };
}


function mappingPaths(platform: string): string[] {
  const out: string[] = [];
  const own = join(PLUGIN_ROOT, 'skills', `migrate-${platform}`, 'mappings', `${platform}.yaml`);
  if (existsSync(own)) out.push(own);
  out.push(join(PLUGIN_ROOT, 'skills', 'migrate-generic', 'mappings', 'generic.yaml'));
  return out;
}


function repoTree(root: string, platform: string): Tree {
  const pages = sourceFiles(root).map((file, order): TreePage => {
    const rel = file.slice(resolve(root).length + 1).replace(/\\/g, '/');
    const raw = readFileSync(file, 'utf8');
    const fmTitle = raw.match(/^---\r?\n[\s\S]*?^title:\s*["']?([^\n"']+)/m)?.[1]?.trim();
    const heading = raw.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const stem = rel.replace(/\.(?:md|mdx|html?)$/i, '').replace(/(?:^|\/)index$/i, '');
    const title = fmTitle ?? heading ?? rel.split('/').pop()!.replace(/\.(?:md|mdx|html?)$/i, '').replace(/[-_]+/g, ' ');
    return { id: pageIdFromPlatform(platform, rel), title, source: rel, group: rel.split('/').slice(0, -1).map((x) => x.replace(/[-_]+/g, ' ')), order, oldPath: '/' + stem, migrate: true, reason: 'source-repo' };
  });
  return { scope: 'full', platform, pages };
}

/** The seed site's paired hosts from the profile plus the hosts discovery recorded from robots.txt and llms.txt. */
function sourceCanonicalHosts(workspace: string, seedUrl: string, profile: ScrapeProfile): CanonicalHosts {
  const recorded = existsSync(canonicalHostsPath(workspace)) ? readJson<{ aliases: string[] }>(canonicalHostsPath(workspace)).aliases : [];
  return new CanonicalHosts(new URL(seedUrl).origin, [...profileHostAliases(profile, new URL(seedUrl).hostname), ...recorded]);
}

/** How links resolve in this workspace's migrated site: the tree's routes, every path the frozen source is known to publish, the source's host aliases and the URL plan's choice for unmigrated links. */

function readComponentPlan(workspace: string): Record<string, ComponentPlanEntry> {
  const p = join(workspace, 'plan', 'component-plan.yaml');
  if (!existsSync(p)) return {};
  const y = parseYaml(readFileSync(p, 'utf8')) as { components: Array<ComponentPlanEntry & { signature?: { hash?: string } }> };
  const out: Record<string, ComponentPlanEntry> = {};
  // the engine looks entries up by the full signature hash recorded in the plan
  for (const c of y.components ?? []) if (c.signature?.hash) out[c.signature.hash] = c;
  return out;
}


/**
 * The frozen crawl, with the navigation re-read from the acquired pages by the current
 * migrator. The source universe (which pages exist, and the evidence for each) comes from
 * the frozen capture untouched; only what the migrator derives from those bytes is rebuilt,
 * which is the part a fix to the migrator can change.
 */
function frozenDiscovery(workspace: string, session: Session, profile: ScrapeProfile, url: string, platform: string): { frozen: DiscoveryResult; derived: DiscoveryResult } {
  const path = join(workspace, 'source-cache', 'discovery-result.json');
  if (!existsSync(path)) fail('--offline needs the frozen discovery result, which this workspace never recorded; discover online once first');
  requireSourceManifest(workspace, session.hashes.sourceManifest);
  const discovery = readJson<DiscoveryResult>(path);
  const frozen = discovery.pages.map((page) => ({ url: page.url, html: acquiredHtml(workspace, pageIdFromPlatform(platform, page.url)) })).filter((page) => page.html);
  if (!frozen.length) fail('--offline found no acquired page bodies to re-read; run acquire before re-deriving');
  const derived = navigationFromFrozenPages(frozen, platform, url, new URL(url).origin, profile, new Map((discovery.navigationData ?? []).map((file) => [file.url, file.body])));
  ok(`${frozen.length} frozen page(s) re-read with no network; navigation from ${derived?.source ?? 'the frozen capture, unchanged'}`);
  // Re-read the site's name from the same frozen titles, so a capture taken before the migrator
  // could read it gains the name on rebuild instead of needing the site crawled again.
  const siteName = discovery.siteName
    ?? siteNameFromTitleTags(discovery.pages.map((page) => page.htmlTitleTag))
    // The help system frozen with the capture names the page it opens on, and that page's title is
    // the site's name. Reading it here means a capture taken before the migrator could read it
    // gains the name on a rebuild, instead of needing the site crawled again.
    ?? flareSiteName(discovery);
  const rebuilt = { ...discovery, ...(siteName ? { siteName } : {}) };
  return { frozen: discovery, derived: derived ? { ...rebuilt, navigation: derived.nodes, navigationSource: derived.source } : rebuilt };
}




/** The site name a frozen MadCap capture states: the title of the page its help system opens on. */
function flareSiteName(discovery: DiscoveryResult): string | undefined {
  const root = discovery.helpSystems?.find((system) => system.seed)?.root;
  if (!root) return undefined;
  for (const file of discovery.navigationData ?? []) {
    if (!/HelpSystem\.xml$|\.mcwebhelp$/i.test(file.url)) continue;
    const defaultUrl = defaultUrlFromHelpSystem(file.body, root);
    const page = defaultUrl ? discovery.pages.find((entry) => entry.url === defaultUrl) : undefined;
    const title = page?.htmlTitleTag?.trim();
    if (title) return title;
  }
  return undefined;
}

/** The Documentation.AI renderer's sidebar container, used to check the deployed navigation. */
const DAI_PREVIEW_NAV_SELECTOR = 'nav, aside, [role=navigation]';
/** The rendered page's own content on a Documentation.AI preview: title, description and MDX body, without the breadcrumbs, feedback, prev/next and footer the theme puts around them. */
const DAI_PREVIEW_CONTENT_SELECTORS = ['.page-title', '.page-description', '.mdx-container'];


/** New paths (without extension) of the pages whose converted file exists in output/. */

async function main() {
  switch (cmd) {
    case 'init': {
      const workspace = ws();
      assertOutsidePlugin(workspace, PLUGIN_ROOT);
      if (!v.source) fail('--source is required');
      if (v.target !== 'customer-org' && v.target !== 'demo-org') fail('--target must be customer-org or demo-org');
      if (v.fidelity !== 'exact' && v.fidelity !== 'permissive') fail('--fidelity must be exact or permissive');
      const migrator = captureMigratorProvenance({ repoRoot: PLUGIN_ROOT, packageVersion: CORE_VERSION });
      ensureWorkspace(workspace);
      const contract = loadContract();
      const allowedOrgs = v['allowed-orgs']!.split(',').map((s) => s.trim()).filter(Boolean);
      const s3Configured = s3StorageProblems(s3StorageFromEnv(process.env)).length === 0;
      const pre = await preflight({ target: { landing: v.target as 'customer-org' | 'demo-org', repoRemote: v.remote }, allowedRemoteOrgs: allowedOrgs, daiApiBase: process.env.DAI_API_BASE, daiApiKey: process.env.DAI_API_KEY, s3Configured });
      for (const c of pre.checks) console.log(`  ${c.status === 'ok' ? '✔' : c.status === 'fail' ? '✖' : '·'} ${c.id}: ${c.detail}`);
      if (pre.checks.some((c) => c.status === 'fail')) fail('preflight failed; fix the connection issues above before migrating (nothing was written)');
      writeJson(join(workspace, 'report', 'preflight.json'), pre.checks);
      const session: Session = {
        migrationId: newMigrationId(), createdAt: new Date().toISOString(),
        source: {
          kind: v.export ? 'export' : v.repo ? 'repo' : /^https?:\/\//.test(v.source!) ? 'url' : existsSync(v.source!) && statSync(v.source!).isDirectory() ? 'repo' : 'export',
          location: v.export ?? v.repo ?? v.source!, platform: v.platform,
        },
        target: { landing: v.target as 'customer-org' | 'demo-org', ...pre.target },
        scope: 'full', customerAuthorisedCrawl: !!v['customer-authorised'], fidelityMode: v.fidelity, migrator,
        versions: { core: CORE_VERSION, contentContract: contract.contractVersion, parsers: { htmlparser2: '10' } },
        hashes: {}, stages: {},
      };
      writeSession(workspace, session);
      writeJson(join(workspace, 'plan', 'allowed-orgs.json'), allowedOrgs);
      ok(`session ${session.migrationId} at ${workspace} (landing: ${session.target.landing}; assets: ${session.target.assetProvider ?? 'local'}; remote: ${session.target.repoRemote ?? 'not set'}; fidelity: ${session.fidelityMode}; migrator: ${migrator.gitSha.slice(0, 12)}${migrator.dirty ? ' with uncommitted changes' : ''})`);
      break;
    }
    case 'fingerprint': {
      const workspace = ws(); const s = readSession(workspace);
      let html: string | undefined; let paths: string[] | undefined;
      const src = v.url ?? v.export ?? v.repo ?? s.source.location;
      if (/^https?:\/\//.test(src)) { const f = new Fetcher(networkOptions(workspace, s, [new URL(src).hostname])); html = (await f.get(src)).body; }
      else if (existsSync(src)) { const root = await extractIfZip(src, join(workspace, 'source-cache', 'export')); const walk = (d: string, out: string[] = []): string[] => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) { if (out.length < 5000) walk(p, out); } else out.push(p.slice(root.length + 1)); } return out; }; paths = walk(root); }
      const fp = fingerprint({ html, paths });
      writeJson(join(workspace, 'plan', 'fingerprint.json'), fp);
      if (fp.best) ok(`${fp.best.platform} (${fp.best.confidence.toFixed(2)}) matched ${fp.best.matched.join(', ')}`);
      if (fp.ambiguous && s.source.platform) console.log(`· fingerprint is ambiguous (${fp.reason}); continuing with the explicitly selected platform ${s.source.platform}`);
      else if (fp.ambiguous) console.log(`? input required (not a standard human gate): ${fp.reason}. Pass --platform to init or choose a skill explicitly.`);
      else if (!s.source.platform) { s.source.platform = fp.best!.platform; s.source.platformConfidence = fp.best!.confidence; writeSession(workspace, s); }
      break;
    }
    case 'discover': {
      const workspace = ws(); const s = readSession(workspace);
      if (existsSync(sourceManifestPath(workspace)) && !v.offline) fail('source evidence is already frozen; review the existing tree, or re-derive it from those frozen bytes with --offline after "rebase"');
      if (v.offline) {
        if (s.source.kind !== 'url') fail('--offline re-derives a live-site capture; a repository or export source is already local, so discover it in a new workspace');
        // A completed acquisition is the precondition: it exists only where discover produced a tree
        // to acquire, and it is what --offline re-reads. The last discover's own status is not,
        // because a re-derivation that failed certification must stay retryable — stranding the
        // workspace on a failed rebuild would force exactly the re-crawl --offline exists to avoid.
        requireStages(s, 'acquire');
      }
      const platform = s.source.platform ?? v.platform;
      let tree: Tree;
      let sourceManifest: SourceManifest | undefined;
      let frozen: FreezeResult | undefined;
      /** The help systems the crawl found, so a scope decision can name one. Empty for non-live sources. */
      let discoveryHelpSystems: DiscoveredHelpSystem[] = [];
      const captureContext = { location: s.source.location, platform: platform ?? 'generic', contentContractVersion: s.versions.contentContract, capturedAt: new Date().toISOString() };
      if (v.export ?? (s.source.kind === 'export' ? s.source.location : undefined)) {
        const src = v.export ?? s.source.location;
        const extracted = await extractIfZip(src, join(workspace, 'source-cache', 'export'));
        const root = frozenRootPath(workspace);
        frozen = freezeDirectory(extracted, root);
        if (platform !== 'document360') fail(`export discovery is implemented for document360; got ${platform ?? 'unknown'} (pass --platform document360 at init)`);
        const exp: D360Export = readD360Export(root);
        writeJson(join(workspace, 'inventory', 'export-unplaced.json'), exp.unplaced);
        const pages: TreePage[] = exp.articles.sort((a, b) => a.order - b.order).map((a, i) => ({
          id: pageIdFromPlatform('document360', a.platformId), title: a.title, source: a.file.slice(root.length + 1), group: [...(exp.workspaces.length > 1 ? [a.workspace] : []), ...a.categoryPath].filter(Boolean), order: i,
          oldPath: `/docs/${a.slug}`, migrate: true, locale: a.language, version: a.workspace, reason: a.categoryPath.includes('(uncategorised)') ? 'not in category json' : undefined,
        }));
        tree = { scope: 'full', platform: 'document360', pages };
        ok(`${pages.length} articles across workspaces [${exp.workspaces.join(', ')}]; ${exp.unplaced.length} unplaced entries; ${exp.snippetTokens.size} distinct snippet tokens`);
        writeJson(join(workspace, 'inventory', 'snippets.json'), [...exp.snippetTokens.entries()].map(([token, count]) => ({ token, count, body: null, resolution: 'blocked' })));
      } else {
        const url = v.url ?? s.source.location;
        if (!/^https?:\/\//.test(url) && existsSync(url)) {
          const root = frozenRootPath(workspace);
          frozen = freezeDirectory(resolve(url), root);
          const meta: Record<string, unknown> = { platform: platform ?? 'generic', root };
          // One registry decides what a repository is, reads it, and states its navigation, so
          // discovery and verification cannot disagree about the platform. A platform the operator
          // named wins over what the files look like.
          const adapter = adapterFor(root, platform);
          if (adapter) {
            sourceManifest = nativeSourceManifest({ ...captureContext, platform: adapter.platform, kind: 'repo', root, freeze: frozen });
            const read = adapter.read(root);
            tree = read.tree;
            Object.assign(meta, read.meta);
            for (const note of read.notes) console.log(`· ${note}`);
            ok(read.summary);
          } else {
            sourceManifest = nativeSourceManifest({ ...captureContext, kind: 'repo', root, freeze: frozen });
            tree = repoTree(root, platform ?? 'generic');
            ok(`${tree.pages.length} Markdown, MDX, and HTML pages discovered in the source repository (provisional groups from paths)`);
          }
          if (!s.source.platform && meta.platform !== 'generic') { s.source.platform = String(meta.platform); writeSession(workspace, s); }
          writeJson(join(workspace, 'inventory', 'platform-meta.json'), meta);
        } else if ((platform === 'readme') && process.env.README_API_KEY) {
          // Native source: ReadMe API v2. Bodies are stored as acquired pages so inventory needs no scraping.
          const api = new ReadmeApi({ apiKey: process.env.README_API_KEY, branch: process.env.README_BRANCH });
          const pages = [...(await api.pages('guides')), ...(await api.pages('reference'))];
          const apiIndex = JSON.stringify(pages);
          writeFileSync(join(workspace, 'source-cache', 'api-index.json'), apiIndex, { mode: 0o600 });
          sourceManifest = {
            schemaVersion: 1, capturedAt: captureContext.capturedAt, source: { kind: 'api', platform: 'readme', location: s.source.location }, contentContractVersion: s.versions.contentContract,
            indexes: [{ kind: 'api-list', location: 'api-index.json', sha256: sha256(apiIndex), entries: pages.length }],
            pages: pages.map((page) => ({ pageId: pageIdFromPlatform('readme', `${page.kind}:${page.slug}`), sourceId: `${page.kind}:${page.slug}`, location: `readme-api://${page.kind}/${page.slug}`, published: !page.hidden, evidence: ['api-list'], rawSha256: sha256(page.body) })),
            issues: ['ReadMe API pagination completeness is not independently proven'],
          };
          tree = readmeApiTree(pages);
          const bodies = new Map(pages.map((p) => [`${p.kind}:${p.slug}`, p]));
          mkdirSync(join(workspace, 'source-cache', 'acquired'), { recursive: true, mode: 0o700 });
          for (const t of tree.pages) {
            const p = bodies.get(t.source.replace('readme-api://', '').replace('/', ':'))!;
            const acquired: AcquiredPage = p.bodyType === 'markdown' ? { url: t.source, markdown: p.body, markdownSha256: sha256(p.body), title: p.title } : { url: t.source, html: p.body, htmlSha256: sha256(p.body), contentType: 'text/html', title: p.title };
            writeJson(acquiredPath(workspace, t.id), acquired);
          }
          markStage(workspace, 'acquire', 'done', 'readme-api');
          ok(`${tree.pages.length} pages from the ReadMe API (guides + reference), bodies acquired; ${pages.filter((p) => p.hidden).length} hidden pages skipped`);
        } else {
          const host = new URL(url).hostname;
          const profile = getProfile(v.profile ?? platform ?? 'generic');
          const canonicalHosts = new CanonicalHosts(new URL(url).origin, profileHostAliases(profile, host));
          const f = new Fetcher({ ...networkOptions(workspace, s, [host]), canonicalHosts });
          let fc: Firecrawl | undefined;
          if (v.fetcher === 'firecrawl' && process.env.FIRECRAWL_API_KEY) {
            fc = new Firecrawl(await firecrawlOptions(workspace, s, url));
          }
          const limit = Number(v['discovery-limit']);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) fail('--discovery-limit must be an integer from 1 to 50000');
          const reread = v.offline ? frozenDiscovery(workspace, s, profile, url, platform ?? 'generic') : undefined;
          const discovery = reread ? reread.derived : await discoverLiveSite({ seedUrl: url, fetcher: f, profile, limit, concurrency: Number(v.concurrency), map: fc ? (u, n) => fc!.map(u, { limit: n }) : undefined });
          discoveryHelpSystems = discovery.helpSystems ?? [];
          // The manifest describes the capture, so it is built from the frozen crawl and keeps its
          // timestamp; only the tree below is rebuilt from it. A re-derivation that would alter the
          // manifest is a different capture, and writeSourceManifest refuses it.
          const capturedAt = reread ? requireSourceManifest(workspace, s.hashes.sourceManifest).capturedAt : captureContext.capturedAt;
          sourceManifest = liveSourceManifest({ ...captureContext, capturedAt, location: url }, reread ? reread.frozen : discovery);
          if (!reread) {
            writeFileSync(join(workspace, 'source-cache', 'discovery-result.json'), JSON.stringify(discovery), { mode: 0o600 });
            if (discovery.robots) writeFileSync(join(workspace, 'source-cache', 'robots.txt'), discovery.robots.body, { mode: 0o600 });
          }
          writeJson(join(workspace, 'inventory', 'discovery-failures.json'), discovery.failures);
          writeJson(join(workspace, 'inventory', 'sitemaps.json'), discovery.sitemaps);
          writeJson(join(workspace, 'inventory', 'llms.json'), discovery.llms ?? null);
          writeJson(canonicalHostsPath(workspace), { seed: canonicalHosts.seedOrigin, aliases: discovery.canonicalHosts });
          const orderTier = { sidebar: 0, sitemap: 1, crawl: 2 } as const;
          // A site that builds its navigation in the browser renders no sidebar in any page we hold.
          // That is unobserved, not absent, so no page is told to hide a sidebar on that evidence.
          const observedSidebar = sidebarObserved(discovery.pages);
          const pages: TreePage[] = discovery.pages.sort((a, b) => orderTier[a.orderSource] - orderTier[b.orderSource] || a.orderHint - b.orderHint || a.url.localeCompare(b.url)).map(({ url: u, reasons, title, description, sidebarTitle, domSidebarTitle, llms, groupHint, locale, version, sitemap, sidebarPages }, i) => {
            const parsed = new URL(u);
            const parts = parsed.pathname.split('/').filter(Boolean);
            let pathGroups = parts.slice(0, -1);
            if (locale && pathGroups[0]?.toLowerCase() === locale.toLowerCase()) pathGroups = pathGroups.slice(1);
            const groups = pathGroups.length ? pathGroups.map((x) => decodeURIComponent(x).replace(/[-_]+/g, ' ')) : (groupHint ?? []);
            // A URL-derived title is a placeholder, marked as such: inventory replaces it with the page's own H1 and exact mode refuses one that survives.
            const titleSource: TreePage['titleSource'] = llms?.title ? 'llms-txt' : title ? 'platform-metadata' : 'path';
            return {
              id: pageIdFromPlatform(platform ?? 'generic', u), title: llms?.title ?? title ?? decodeURIComponent(parts.at(-1) ?? 'index').replace(/\.(?:html?|xhtml|md|mdx|aspx?|php|jsp)$/i, '').replace(/[-_]+/g, ' '), titleSource, sidebarTitle, domSidebarTitle, description, llms, source: u,
              group: groups, order: i, oldPath: parsed.pathname, migrate: true, locale, version, reason: reasons.join('+'),
              ...(observedSidebar ? { sourceSidebar: (sidebarPages ?? 0) >= 2 ? 'rendered' as const : 'absent' as const } : {}),
              discovery: sitemap ? { sitemap: sitemap.source, sitemapOrder: sitemap.order, lastmod: sitemap.lastmod, changefreq: sitemap.changefreq, priority: sitemap.priority, groupHint } : undefined,
            };
          });
          const pageIdByUrl = new Map(pages.map((page) => [page.source.replace(/\/$/, ''), page.id]));
          // A URL that redirects to a discovered page names that page: the navigation may still link the old name.
          for (const found of discovery.pages) {
            if (!found.aliases?.length) continue;
            const page = pages.find((entry) => entry.source === found.url)!;
            page.aliases = found.aliases.map((alias) => new URL(alias).pathname);
            for (const alias of found.aliases) pageIdByUrl.set(alias.replace(/\/$/, ''), page.id);
          }
          // A navigation entry the page set cannot account for means discovery missed a page.
          // Dropping it silently is how a group vanished from the last migration, so exact mode stops here.
          const unmappedNavigationUrls: string[] = [];
          const mapNavigation = (nodes: import('./scrape/discovery.js').DiscoveredNavigationNode[]): SourceNavigationNode[] => {
            const out: SourceNavigationNode[] = [];
            for (const node of nodes) {
            if (node.type === 'page') {
              const pageId = pageIdByUrl.get(node.url.replace(/\/$/, ''));
              if (pageId) out.push({ type: 'page', pageId, title: node.title });
              else unmappedNavigationUrls.push(node.url);
              continue;
            }
            const children = mapNavigation(node.children);
            const { pageUrl, ...container } = node;
            const ownId = pageUrl ? pageIdByUrl.get(pageUrl.replace(/\/$/, '')) : undefined;
            if (pageUrl && !ownId) unmappedNavigationUrls.push(pageUrl);
            if (children.length || node.href || ownId) out.push({ ...container, ...(ownId ? { pageId: ownId } : {}), children });
            }
            return out;
          };
          const navigation = discovery.navigation ? mapNavigation(discovery.navigation) : undefined;
          if (navigation?.length) {
            // A page the site publishes but does not place in its sidebar migrates as a file and is reported; it is never given an invented group.
            const placed = placedPageIds(navigation);
            for (const page of pages) page.navMembership = placed.has(page.id) ? 'listed' : 'unlisted';
          }
          if (unmappedNavigationUrls.length && (s.fidelityMode ?? 'exact') === 'exact') {
            fail(`${unmappedNavigationUrls.length} page(s) in the source navigation are not in the discovered page set, so their placement would be lost:\n${unmappedNavigationUrls.map((u) => `  ${u}`).join('\n')}\nraise --limit, check the crawl allowlist, or re-run init with --fidelity permissive`);
          }
          for (const url of unmappedNavigationUrls) console.log(`· navigation page not discovered, placement dropped: ${url}`);
          const fallbackSource = pages.some((page) => page.discovery?.groupHint?.length) ? 'sitemap-hint' as const : 'url-path' as const;
          tree = { scope: 'full', platform: platform ?? 'generic', pages, navigation, navigationSource: navigation?.length ? (discovery.navigationSource ?? 'platform-metadata') : fallbackSource };
          // The site's own declaration (docsConfig) is authoritative; og:site_name is the fallback for platforms that publish none.
          const siteMeta: PlatformMeta & { platform: string } = {
            platform: platform ?? 'generic',
            ...discovery.siteConfig,
            ...(discovery.siteConfig?.name ? {} : discovery.siteName ? { name: discovery.siteName } : {}),
          };
          writeJson(join(workspace, 'inventory', 'platform-meta.json'), siteMeta);
          const withoutSidebar = pages.filter((page) => page.sourceSidebar === 'absent').length;
          if (!observedSidebar) console.log('· no page in the capture rendered a navigation sidebar; the source builds one in the browser or shows none. Page layout is left at the Documentation.AI default and the navigation could not be read from the rendered pages.');
          else if (withoutSidebar) ok(`${withoutSidebar} page(s) render no navigation sidebar in the source and will be written with "show-sidebar": false`);
          if (discovery.refusedOutsideBase?.length) ok(`${discovery.refusedOutsideBase.length} same-origin URL(s) outside the site's base path were refused as another site on this host: ${discovery.refusedOutsideBase.slice(0, 3).join(', ')}`);
          if (discovery.externalLlmsLinks?.length) ok(`${discovery.externalLlmsLinks.length} llms.txt entr(y/ies) link to another site and are not pages of this one: ${discovery.externalLlmsLinks.slice(0, 3).map((link) => `"${link.title}" → ${link.url}`).join(', ')}`);
          ok(`${pages.length} unique URLs from ${discovery.llms ? `${discovery.llms.entries.length} llms.txt entries, ` : ''}recursive links, sidebars, ${discovery.sitemaps.sources.length} sitemap file(s) and configured map sources${discovery.canonicalHosts.length ? ` (canonical hosts: ${discovery.canonicalHosts.join(', ')})` : ''}; ${discovery.failures.length} fetch failures${discovery.truncated ? '; limit reached' : ''}`);
        }
      }
      if (frozen && !sourceManifest) sourceManifest = nativeSourceManifest({ ...captureContext, platform: tree.platform, kind: s.source.kind === 'export' ? 'export' : 'repo', root: frozenRootPath(workspace), freeze: frozen });
      if (!sourceManifest) fail('discovery produced no independent source manifest');
      // The frozen manifest is never rewritten. If this build would capture a different source
      // universe, that is a new capture, not a re-derivation, and it needs its own workspace.
      let manifestHash: string;
      try { manifestHash = writeSourceManifest(workspace, sourceManifest); }
      catch (error) {
        if (!v.offline) throw error;
        // One correction is allowed offline: pages discovery refused as another site on this host
        // (the marketing pages beside the docs) leaving the manifest, where an earlier build had
        // listed them as published pages of the source. Nothing else about the universe may move.
        const refused = new Set(readJson<DiscoveryResult>(join(workspace, 'source-cache', 'discovery-result.json')).refusedOutsideBase ?? []);
        try {
          const narrowed = narrowSourceManifest(workspace, sourceManifest, refused);
          manifestHash = narrowed.hash;
          ok(`${narrowed.dropped.length} page(s) outside the site's base path left the frozen source universe; discovery had refused them as another site on this host and they were never candidates`);
        } catch (narrowError) {
          fail(`offline re-derivation would change the frozen source universe (${(narrowError as Error).message}); capture it afresh in a new workspace`);
        }
      }
      const discoveredSession = readSession(workspace);
      discoveredSession.hashes.sourceManifest = manifestHash;
      if (sourceManifest.source.kind === 'api') discoveredSession.hashes.acquisition = pinAcquisition(workspace, sourceManifest, tree.pages.filter((page) => page.migrate), false).hash;
      // A narrowed manifest is a new hash, and a completed live acquisition names the manifest it
      // belongs to. Left alone, every workspace that had already acquired would refuse its own
      // frozen bytes from inventory onward; the bytes never moved, so the pin follows the correction.
      else if (v.offline) discoveredSession.hashes.acquisition = reanchorAcquisition(workspace, sourceManifest, discoveredSession.hashes.acquisition);
      writeSession(workspace, discoveredSession);
      ensureScopeDecisionsFile(workspace);
      if (v.offline && existsSync(join(workspace, 'plan', 'tree.yaml'))) {
        // the operator's reviewed scope survives; only the structure the migrator derives is rebuilt
        const reviewed = new Map(readTree(workspace).pages.map((page) => [page.id, page]));
        let carried = 0;
        for (const page of tree.pages) {
          const previous = reviewed.get(page.id);
          if (previous && previous.migrate !== page.migrate) { page.migrate = previous.migrate; page.reason = previous.reason; carried++; }
        }
        const absent = [...reviewed.values()].filter((page) => !tree.pages.some((entry) => entry.id === page.id));
        // Where the operator decided pages the source never placed should go is a gate 1 decision
        // like any other, and the rebuild derives structure, not decisions. Dropping it would put
        // those pages back outside the navigation — where the renderer answers 404 for them —
        // quietly, on the next rebuild after the one that fixed it.
        const previous = readTree(workspace);
        if (previous.unlistedPlacement) {
          tree.unlistedPlacement = previous.unlistedPlacement;
          tree.navigationSource = 'manual';
          ok(`the reviewed placement of pages the source never named carried onto the rebuilt tree (by ${previous.unlistedPlacement.approvedBy})`);
        }
        if (carried) ok(`${carried} reviewed scope decision(s) carried onto the rebuilt tree`);
        for (const page of absent.slice(0, 5)) console.log(`· page in the reviewed tree is absent from the rebuilt tree: ${page.source}`);
      }
      // A host that publishes several independent help systems asks the operator a question rather
      // than presenting a defect: which one does this run migrate? The answer is recorded here as
      // ordinary attributed exclusions, so the source universe still reconciles page for page and
      // the report says who decided. An unanswered system still stops the run below.
      const excludedHelpSystems = v['exclude-help-system'] ?? [];
      let answeredIssues: string[] = [];
      if (excludedHelpSystems.length) {
        const by = (v.by ?? '').trim();
        if (!by) fail('--exclude-help-system needs --by "<who>": leaving a published help system out of a migration is a decision that records its approver');
        const decided = excludeHelpSystems({
          roots: excludedHelpSystems,
          helpSystems: discoveryHelpSystems,
          manifestPages: sourceManifest.pages,
          approvedBy: by,
          approvedAt: new Date().toISOString(),
        });
        if (decided.refusals.length) fail(`--exclude-help-system refused:\n${decided.refusals.map((r) => `  ${r}`).join('\n')}`);
        const excludedIds = new Set(decided.exclusions.map((entry) => entry.pageId));
        for (const page of tree.pages) if (excludedIds.has(page.id)) { page.migrate = false; page.reason = 'help system out of scope'; }
        const recorded = recordScopeExclusions(workspace, decided.exclusions, decided.decisions);
        answeredIssues = decided.answeredIssues;
        ok(`${excludedHelpSystems.length} help system(s) recorded out of scope by ${by}: ${recorded} page(s) excluded with attribution in ${scopeDecisionsPath(workspace)}`);
      }
      writeTree(workspace, tree);
      // Decisions already recorded in this workspace answer their issues on every later
      // re-derivation, so an offline rebuild after a migrator fix does not ask again.
      const settled = new Set([...answeredIssues, ...answeredHelpSystemIssues(readScopeDecisions(workspace), sourceManifest.issues ?? [])]);
      const blockingIssues = (sourceManifest.issues ?? []).filter((issue) => !settled.has(issue));
      if (blockingIssues.length && (s.fidelityMode ?? 'exact') === 'exact') {
        markStage(workspace, 'discover', 'failed', 'source universe unproven');
        fail(`source discovery cannot be certified: ${blockingIssues.slice(0, 8).join('; ')}. See ${sourceManifestPath(workspace)}; fix the source or adapter and discover in a new workspace`);
      }
      markStage(workspace, 'discover', 'done');
      humanGate(1, 'scope and structure', `review ${join(workspace, 'plan', 'tree.yaml')} plus source-specific inventory; confirm pages, groups, order, versions and locales before acquisition/inventory`);
      break;
    }
    case 'approve': {
      // A human gate is a decision about a specific state, so approving pins that state. Changing
      // it afterwards leaves the approval behind, and the next stage says which file moved.
      const workspace = ws(); const s = readSession(workspace);
      const gate = Number(v.gate);
      if (![1, 2, 3, 4].includes(gate)) fail('--gate must be 1, 2, 3 or 4');
      const by = (v.by ?? '').trim();
      if (!by) fail('--by is required: record who approved this gate');
      const number = gate as 1 | 2 | 3 | 4;
      const subjects = gateSubjects(workspace, number);
      if (!subjects.length) fail(`nothing to approve for gate ${number} (${GATE_NAMES[number]}): its files do not exist yet, so the stage before it has not run`);
      s.approvals = { ...s.approvals, [number]: { at: new Date().toISOString(), by, ...(v.note ? { note: v.note } : {}), pinned: pinGateSubjects(workspace, number) } };
      writeSession(workspace, s);
      ok(`human gate ${number} (${GATE_NAMES[number]}) approved by ${by}; pinned ${subjects.join(', ')}`);
      break;
    }
    case 'rebase': {
      // A fix to the migrator invalidates what the migrator derived, never what the source served.
      // Rebasing keeps the frozen bytes and their pins, stales every derivation, and records the
      // build change so the certificate shows each build that touched this migration.
      const workspace = ws(); const s = readSession(workspace);
      // A discover that froze the source and then failed is exactly what a migrator fix is made for:
      // the bytes are captured, only the reading of them was wrong. Requiring a *complete* discover
      // would strand that workspace, forcing the site to be crawled again to apply the fix. What has
      // to hold is that the frozen evidence and the tree are present and unchanged, which
      // requireSourceManifest and requireAcquisition below enforce on their own.
      if (!s.stages.discover) fail('this workspace has not discovered a source yet; there is nothing to rebase');
      const reason = (v.reason ?? '').trim();
      if (!reason) fail('--reason is required: record why this workspace moves onto a new migrator build');
      const current = captureMigratorProvenance({ repoRoot: PLUGIN_ROOT, packageVersion: CORE_VERSION });
      const drift = migratorDrift(s.migrator, current);
      if (!drift.length) fail(`the migrator has not changed since this session was pinned (${describeMigrator(current)}); there is nothing to rebase`);
      const manifest = requireSourceManifest(workspace, s.hashes.sourceManifest);
      requireAcquisition(workspace, manifest, s.hashes.acquisition, readTree(workspace).pages);
      s.rebases = [...(s.rebases ?? []), { at: new Date().toISOString(), reason, from: s.migrator, to: current, sourceManifest: s.hashes.sourceManifest, acquisition: s.hashes.acquisition }];
      s.migrator = current;
      // every derivation of the frozen bytes is stale; the frozen bytes, their pins and the
      // captured OpenAPI graph are untouched, because no fix to this migrator can change them
      for (const key of ['snapshot', 'componentPlan', 'urlPlan', 'assetPlan', 'blockExclusions', 'scopeDecisions', 'canonicalOutput', 'convertInputs', 'convertOutput', 'previousConvertOutput'] as const) s.hashes[key] = undefined;
      for (const stage of ['inventory', 'plan', 'assets', 'convert', 'nav', 'verify', 'write', 'report']) {
        if (s.stages[stage]) s.stages[stage] = { status: 'pending', at: new Date().toISOString(), note: `stale: rebased onto ${current.gitSha.slice(0, 12)}` };
      }
      writeSession(workspace, s);
      ok(`rebased onto ${describeMigrator(current)} (${drift.join('; ')})`);
      ok(`frozen source kept: ${manifest.pages.length} page(s) and their acquisition pin are intact, so nothing is fetched again`);
      ok(`next: "discover --offline" to rebuild the tree and navigation from those bytes, then inventory onward`);
      break;
    }
    case 'acquire': {
      const workspace = ws(); const s = readSession(workspace); const tree = readTree(workspace);
      requireStages(s, 'discover');
      const sourceManifest = requireSourceManifest(workspace, s.hashes.sourceManifest);
      if (s.source.kind === 'repo' || s.source.kind === 'export') {
        s.hashes.openapi = (await captureOpenapiFor(workspace, s, tree)).hash;
        writeSession(workspace, s);
        // The frozen files are this source's served bytes. Recording them as acquisitions is what
        // lets the exactness gates read the output back against the source for a repository or
        // export, exactly as they do for a live site.
        const native = acquireNativePages(workspace, frozenRootPath(workspace), tree.pages);
        writeJson(join(workspace, 'inventory', 'native-acquisition.json'), native);
        // A page with no readable body is reported, never failed here: the exactness gates are
        // where a page without a witness stops the migration, and they name the page.
        for (const page of native.unreadable.slice(0, 5)) console.log(`· no frozen body recorded for ${page.source}: ${page.reason}`);
        if (native.unreadable.length > 5) console.log(`· ${native.unreadable.length - 5} more in inventory/native-acquisition.json`);
        markStage(workspace, 'acquire', 'done', `native source frozen; ${native.recorded} page bodies recorded`);
        ok(`native source and OpenAPI graph acquired; ${native.recorded} frozen page bodies recorded for verification`);
        break;
      }
      if (s.hashes.acquisition) {
        if (v.refresh) fail('acquisition is pinned; use a new workspace for refreshed source bytes');
        requireAcquisition(workspace, sourceManifest, s.hashes.acquisition, tree.pages);
        ok('completed acquisition matches its session pin; no requests needed'); break;
      }
      const profile = getProfile(v.profile ?? tree.platform);
      s.hashes.openapi = (await captureOpenapiFor(workspace, s, tree)).hash;
      writeSession(workspace, s);
      let pages = tree.pages.filter((p) => p.migrate && /^https?:\/\//.test(p.source));
      if (v.urls) {
        const selectedRaw = readJson<unknown>(resolve(v.urls));
        const selected = new Set(Array.isArray(selectedRaw) ? selectedRaw.map(String) : Array.isArray((selectedRaw as any)?.urls) ? (selectedRaw as any).urls.map(String) : []);
        pages = pages.filter((p) => selected.has(p.source));
      }
      const dir = join(workspace, 'source-cache', 'acquired'); mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (v.fetcher === 'firecrawl') {
        if (!process.env.FIRECRAWL_API_KEY) fail('FIRECRAWL_API_KEY is required for --fetcher firecrawl');
        const fc = new Firecrawl(await firecrawlOptions(workspace, s, s.source.location));
        const got = await fc.batchScrape(pages.map((p) => p.source));
        const host = new URL(s.source.location).hostname;
        const publishedFetcher = new Fetcher({ ...networkOptions(workspace, s, [host]), canonicalHosts: sourceCanonicalHosts(workspace, s.source.location, profile) });
        // Firecrawl's generated Markdown is not the publisher's Markdown. Send every page
        // through the same acquisition checks and fetch the declared Markdown separately.
        await acquireFirecrawlPages({ workspace, pages, profile, fidelityMode: s.fidelityMode ?? 'exact', concurrency: Number(v.concurrency), resume: !v.refresh, fetcher: publishedFetcher, responses: got, loadResponse: (url) => readFirecrawlPage(workspace, url), onProgress: progressReporter('acquired', pages.length) });
      } else {
        const host = new URL(s.source.location).hostname;
        const fetcher = new Fetcher({ ...networkOptions(workspace, s, [host]), canonicalHosts: sourceCanonicalHosts(workspace, s.source.location, profile) });
        const report = progressReporter('acquired', pages.length);
        const acquisition = await acquirePages({ workspace, pages, fetcher, profile, fidelityMode: s.fidelityMode ?? 'exact', concurrency: Number(v.concurrency), resume: !v.refresh, onProgress: report });
        for (const fallback of acquisition.markdownUnavailable) console.log(`· ${fallback.url}: published Markdown not acquired (${fallback.reason}); permissive mode keeps the rendered HTML`);
      }
      const pin = pinAcquisition(workspace, sourceManifest, pages, (s.fidelityMode ?? 'exact') === 'exact' && !!profile.mdSuffix);
      s.hashes.acquisition = pin.hash;
      if (pin.drifted.length) {
        // The source published while this run was reading it, so discovery and acquisition saw two
        // different sites. Mixing them is how a migration of a site that never existed is produced.
        writeJson(join(workspace, 'inventory', 'source-drift.json'), pin.drifted);
        for (const page of pin.drifted.slice(0, 5)) console.log(`· source changed during this run: ${page.source}`);
        if ((s.fidelityMode ?? 'exact') === 'exact') fail(`${pin.drifted.length} page(s) changed between discovery and acquisition; see inventory/source-drift.json. Exact mode will not combine two readings of a moving source: start a new workspace to capture it again`);
        console.log(`· ${pin.drifted.length} page(s) changed mid-run; permissive mode keeps the acquired copy`);
      }
      writeSession(workspace, s);
      markStage(workspace, 'acquire', 'done', `${pages.length} pages frozen`);
      ok(`${pages.length} pages acquired into source-cache/acquired`);
      break;
    }
    case 'inventory': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'discover');
      const sourceManifest = requireFrozenInputs(workspace, s);
      if (s.source.kind === 'url') requireStages(s, 'acquire');
      const tree = readTree(workspace);
      const inScope = tree.pages.filter((p) => p.migrate);
      const docs: DocIR[] = [];
      /** Pages whose title heading carried its own anchor, which must survive the heading leaving the body. */
      const titleAnchors = new Map<string, string>();
      /** Pages whose URL-derived placeholder title the source's own H1 replaced here. */
      let statedTitles = 0;
      let root = sourceManifest.frozenRoot ? frozenRootPath(workspace) : resolve(s.source.location);
      if (tree.platform === 'document360' && s.source.kind === 'export') {
        const exp = readD360Export(root);
        root = exp.root;
        const byId = new Map(exp.articles.map((a) => [pageIdFromPlatform('document360', a.platformId), a]));
        for (const p of inScope) { const article = byId.get(p.id); if (article) docs.push(d360ArticleToIr(article, exp.root)); }
      } else if (s.source.kind === 'repo') {
        const profile = getProfile(tree.platform);
        const definitions = scanComponentDefinitions(root);
        if (definitions.length) writeJson(join(workspace, 'inventory', 'component-definitions.json'), definitions);
        for (const p of inScope) {
          const file = resolve(root, p.source);
          if (file !== root && !file.startsWith(root + '/')) fail(`source page escapes repository: ${p.source}`);
          const raw = readFileSync(file, 'utf8');
          if (/\.mdx?$/i.test(file)) {
            // GitBook states a page's title as the file's first heading and renders it as the
            // title, so carrying that heading into the body as well would show the title twice.
            // Every other repository platform states the title in frontmatter, which the parser
            // reads, and for them this is the file unchanged.
            const published = tree.platform === 'gitbook' ? unwrapPublishedMarkdown(raw, 'gitbook', { expectedDescription: p.description }) : { body: raw, title: undefined as string | undefined };
            const title = published.title ?? p.title;
            docs.push(attachDefinitions(named(p.source, () => markdownToIr(published.body, { platform: tree.platform, file: p.source, pageId: p.id, title, resolveSnippet: tree.platform === 'mintlify' ? mintlifySnippetResolver(root) : undefined, codeMetaStrip: profile.codeMetaStrip })), definitions));
          }
          else {
            const ir = htmlToIr(raw, htmlAdapterOptions(profile, { platform: tree.platform, file: p.source }));
            docs.push({ pageId: p.id, platform: tree.platform, source: p.source, frontmatter: { title: p.title }, children: ir.children });
          }
        }
      } else {
        const profile = getProfile(tree.platform);
        for (const p of inScope) {
          const cached = acquiredPath(workspace, p.id);
          if (!existsSync(cached)) fail(`acquired page missing for ${p.source}; run dai-migrate acquire first`);
          const page = readJson<AcquiredPage>(cached);
          if (page.markdown) {
            // The declared description (llms.txt, then platform metadata) is what the published .md's leading blockquote must equal to leave the body.
            const description = page.llms?.description ?? page.description ?? p.description;
            const published = unwrapPublishedMarkdown(page.markdown, tree.platform, { expectedDescription: description });
            // The site's own statements only: its llms.txt entry, then the page's H1, then platform metadata.
            // A URL-derived placeholder is never a title, so exact mode stops rather than inventing one.
            const stated = p.llms?.title ?? published.title ?? (p.titleSource && p.titleSource !== 'path' ? p.title : undefined);
            if (!stated && (s.fidelityMode ?? 'exact') === 'exact') fail(`no source title for ${p.source}: its llms.txt entry and published Markdown H1 lack one, and the tree title is a URL-derived placeholder (titleSource ${p.titleSource ?? 'unset'}); re-run init with --fidelity permissive to fall back to the URL`);
            const title = stated ?? p.title;
            if (stated && p.titleSource === 'path') { p.title = stated; p.titleSource = p.llms?.title ? 'llms-txt' : 'published-markdown'; statedTitles++; }
            // The rendered page states the search metadata even on a platform whose body is Markdown,
            // so it is read from the frozen HTML and carried; a canonical naming another page is
            // retargeted at convert, with the links.
            const seo = page.html ? seoFrontmatter(extractSeo(page.html, p.source), { url: p.source, title, description }, () => undefined, profile.generatedOgImage) : {};
            docs.push(named(p.source, () => markdownToIr(published.body, { platform: tree.platform, file: p.source, pageId: p.id, title, frontmatter: { title, ...(description ? { description } : {}), ...seo }, codeMetaStrip: profile.codeMetaStrip })));
          }
          else {
            if (page.html === undefined) fail(`acquired record for ${p.source} holds neither published Markdown nor HTML; run dai-migrate acquire again`);
            const ir = htmlToIr(page.html, htmlAdapterOptions(profile, { platform: tree.platform, file: p.source }));
            // A Flare tile menu names its table of contents relative to the page's help system; the
            // absolute address is what convert reads it under.
            if (tree.platform === 'madcap') {
              const root = helpSystemRoot(page.html, p.source);
              walkBlocks(ir.children, (b) => {
                if (b.type !== 'component' || b.name !== 'MCLinkedToc' || typeof b.props.toc !== 'string' || !root) return;
                try { b.props.tocUrl = new URL(b.props.toc, root).toString(); b.props.helpRoot = root; } catch { /* left unresolved; the handler holds the page */ }
              });
            }
            // No published Markdown here, so the page's own title heading is the one the rendered
            // article states: its H1, or the heading it opens with on a generator that reserves H1
            // for the page masthead.
            const firstHeading = titleHeading(ir.children);
            const h1 = firstHeading?.type === 'heading' ? inlineText(firstHeading.children).trim() || undefined : undefined;
            // The site's own statements only: its llms.txt entry, then the rendered article's title
            // heading, then platform metadata. A URL-derived placeholder is never a title, so exact
            // mode stops rather than inventing one.
            const stated = p.llms?.title ?? h1 ?? (p.titleSource && p.titleSource !== 'path' ? p.title : undefined);
            if (!stated && (s.fidelityMode ?? 'exact') === 'exact') fail(`no source title for ${p.source}: its llms.txt entry, the heading the rendered article opens with, and platform metadata all lack one (titleSource ${p.titleSource ?? 'unset'}); exclude the page in plan/scope-decisions.yaml if it states no title because it publishes no article, or re-run init with --fidelity permissive to fall back to the URL`);
            const title = stated ?? p.title;
            if (stated && p.titleSource === 'path') {
              p.title = stated;
              p.titleSource = p.llms?.title ? 'llms-txt' : firstHeading?.type === 'heading' && firstHeading.depth === 1 ? 'rendered-h1' : 'rendered-heading';
              statedTitles++;
            }
            const description = page.llms?.description ?? page.description ?? p.description;
            // The target renders the frontmatter title as the page heading. The source H1 that stated
            // that title would then print a second time under it, so it becomes the title and leaves
            // the body — exactly what unwrapPublishedMarkdown does with a published page's leading H1.
            // Only that one heading goes, and only when it is the title: any other H1 is still content.
            const titleLeaves = firstHeading && h1 && h1 === title;
            // A Flare topic names its own top with an anchor inside that heading (`#top`), and other
            // pages link to it. The heading goes, but the address it published must not: the anchor is
            // recorded against the page and written back at the head of the body when something links
            // to it. It is not put in the IR — it is a link target, not a block the page states.
            if (titleLeaves && firstHeading.type === 'heading' && firstHeading.sourceId) titleAnchors.set(p.id, firstHeading.sourceId);
            const children = titleLeaves ? ir.children.filter((block) => block !== firstHeading) : ir.children;
            const seo = seoFrontmatter(extractSeo(page.html, p.source), { url: p.source, title, description }, () => undefined, profile.generatedOgImage);
            docs.push({ pageId: p.id, platform: tree.platform, source: p.source, frontmatter: { title, ...(description ? { description } : {}), ...seo }, children });
          }
        }
      }
      // The title the source states reaches the tree, not only the page: the sidebar label and the
      // restructured path both read it from there, so leaving the placeholder behind would ship a
      // navigation of URL stems ("p a DeleteAudience") beside pages correctly titled by their H1.
      if (statedTitles) writeTree(workspace, tree);

      // Every offending page is reported in one message: an operator sees the whole list instead of
      // bisecting a repository one failed run at a time.
      const unreadableDimensions = docs.flatMap((doc) => unreadableImageDimensions(doc));
      if (unreadableDimensions.length) {
        if ((s.fidelityMode ?? 'exact') === 'exact') {
          fail(`${unreadableDimensions.length} image dimension(s) the target Image contract cannot carry:\n${unreadableDimensions.map((entry) => `  ${describeUnreadableDimension(entry)}`).join('\n')}\nre-run init with --fidelity permissive to migrate these images without their stated dimension`);
        }
        writeJson(join(workspace, 'report', 'lossy-dimensions.json'), unreadableDimensions);
        for (const entry of unreadableDimensions) console.log(`· ${describeUnreadableDimension(entry)}; permissive mode migrates the image without it`);
      }
      const comps: Array<{ pageId: string; node: any; depth: number; source?: string }> = [];
      const anchors: Array<{ pageId: string; headings: Array<{ id: string; text: string; sourceId?: string }>; titleAnchor?: string }> = [];
      const links: Array<{ pageId: string; url: string }> = [];
      const snapDir = join(workspace, 'snapshot', 'pages'); resetDir(snapDir);
      for (const doc of docs) {
        writeJson(join(snapDir, `${doc.pageId}.json`), doc);
        const heads: Array<{ id: string; text: string; sourceId?: string; aliases?: string[]; component?: boolean }> = [];
        // Mintlify numbers a repeated heading -2, -3 within a page; the count is per page.
        const mintlifySeen = new Map<string, number>();
        walkBlocks(doc.children, (n, depth) => {
          if (n.type === 'component') comps.push({ pageId: doc.pageId, node: n, depth, source: doc.source });
          if (n.type === 'heading') {
            const text = inlineText(n.children);
            // GitBook publishes no explicit ids; its links use the ids its own slugger gives, which is
            // not the renderer's. Recorded as the source id so a link to it gets its shim.
            const gitbook = tree.platform === 'gitbook' && !n.sourceId ? gitbookHeadingIds(text) : [];
            // Mintlify's id is slugged from the rendered heading, badge text included, and differs
            // from the target renderer's on a dot, a badge, or a repeat; a link to it gets its shim.
            let mintlify: string | undefined;
            if (tree.platform === 'mintlify' && !n.sourceId) {
              const base = mintlifyHeadingId(anchorText(n.children));
              const seen = (mintlifySeen.get(base) ?? 0) + 1; mintlifySeen.set(base, seen);
              mintlify = seen > 1 ? `${base}-${seen}` : base;
            }
            heads.push({ id: n.id, text, sourceId: n.sourceId ?? gitbook[0] ?? mintlify, ...(gitbook.length > 1 ? { aliases: gitbook.slice(1) } : {}) });
          }
          // Mintlify gives every parameter field an anchor, `param-<name>`, and pages link to them.
          // The target renders no such id, so the anchor is recorded on the component and written
          // back as a shim where a link still uses it.
          if (n.type === 'component' && tree.platform === 'mintlify' && (n.name === 'ParamField' || n.name === 'ResponseField')) {
            const name = ['name', 'path', 'query', 'body', 'header'].map((key) => n.props[key]).find((value) => typeof value === 'string');
            if (typeof name === 'string') heads.push({ id: n.id, text: '', sourceId: `param-${name}`, component: true });
          }
        });
        // Every link the document holds, not only those directly in a paragraph: a page's own
        // contents links to its sections from inside table cells and list items, and a link nested
        // in bold or a component prop is still a link. Anchor shims are kept only for anchors
        // something points at, so a link counted here is the difference between an inbound
        // cross-reference landing on its section and landing nowhere.
        for (const url of documentLinks(doc)) links.push({ pageId: doc.pageId, url });
        anchors.push({ pageId: doc.pageId, headings: heads, ...(titleAnchors.has(doc.pageId) ? { titleAnchor: titleAnchors.get(doc.pageId) } : {}) });
      }
      const clusters = clusterComponents(comps);
      writeJson(join(workspace, 'inventory', 'components.json'), clusters);
      writeJson(join(workspace, 'inventory', 'anchors.json'), anchors);
      writeJson(join(workspace, 'inventory', 'links.json'), links);
      const snapHash = sha256(readdirSync(snapDir).sort().map((f) => fileHash(join(snapDir, f))).join('\n'));
      s.hashes.snapshot = snapHash; writeSession(workspace, s);
      markStage(workspace, 'inventory', 'done');
      ok(`${docs.length} pages snapshotted, ${clusters.length} component clusters, ${links.length} links${statedTitles ? `, ${statedTitles} URL-derived title(s) replaced by the source's own` : ''}; snapshot ${snapHash.slice(0, 12)}`);
      break;
    }
    case 'plan': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'inventory');
      const tree = readTree(workspace);
      const clusters = readJson<ClusterEntry[]>(join(workspace, 'inventory', 'components.json'));
      const mappings = loadMappings(mappingPaths(tree.platform));
      const engine = new RulesEngine({ platform: tree.platform, mappings, ledger: new Ledger(join(workspace, 'plan')), log: new DecisionLog(join(workspace, 'plan')) });
      const planPath = join(workspace, 'plan', 'component-plan.yaml');
      const existing = existsSync(planPath) ? (parseYaml(readFileSync(planPath, 'utf8')) as { components: ComponentPlanEntry[] }).components : [];
      const byCluster = new Map(existing.map((e) => [e.cluster, e]));
      const components = clusters.map((c) => {
        // A decision the operator made is kept; a derivation is recomputed against current rules.
        const prev = byCluster.get(c.cluster);
        if (planEntryIsDecided(prev)) return prev!;
        const rule = engine.findRule({ id: 'x', type: 'component', name: c.signature.name, platform: c.signature.platform, props: Object.fromEntries(Object.entries(c.signature.props).map(([k, b]) => [k, b.startsWith('enum:') ? b.slice(5) : b === 'null' ? null : 'x'])), children: [], styleDeps: c.signature.styleDeps });
        // An expression the matching rule drops never reaches the output, so it does not hold the
        // cluster back; the engine applies the same test, and the two must agree or the plan and the
        // conversion would disagree about what needed a person to look at it.
        const droppedByRule = new Set([...(rule?.drop ?? []), ...(rule?.dropWhenExpression ?? [])]);
        // A rule that emits nothing cannot carry an expression into the output, so such a cluster is
        // resolved rather than waiting on a person - the same test the engine applies.
        const emitsNothing = rule?.children === 'drop' && !rule.to && !rule.handler;
        const hasExpression = !emitsNothing && c.signature.styleDeps.some((x) => x.startsWith('expression:') && !droppedByRule.has(x.slice('expression:'.length)));
        const entry: ComponentPlanEntry & { count: number; signature: unknown } = {
          cluster: c.cluster, count: c.count, signature: c.signature,
          tier: hasExpression ? 'T7' : rule?.tier ?? 'T7', rule: rule?.id,
          status: rule && !hasExpression ? 'auto' : 'needs-review',
          reason: hasExpression ? 'non-literal MDX expression; never evaluated automatically' : rule ? undefined : 'no mapping rule; T7 preserve as sanitised fragment unless excluded or a rule is added',
        };
        return entry;
      });
      writeFileSync(planPath, toYaml({ components }), { mode: 0o600 });
      const urlOptions = { mode: (v.mode as any) ?? 'preserve', stripPrefix: v['strip-prefix'], case: (v.case as any) ?? 'preserve' } as const;
      const existingUrlPlan = readUrlPlan(workspace);
      // An existing plan is the operator's and is kept; a page the tree gained since it was written
      // (a scope exclusion lifted, a page discovery found on a rerun) gets the entry the default
      // rules give it, or convert would silently skip the page for want of a route.
      const urlPlan = existingUrlPlan ? extendUrlPlan(existingUrlPlan, tree, urlOptions) : defaultUrlPlan(tree, urlOptions);
      writeUrlPlan(workspace, urlPlan);
      if (urlPlan.erased?.length) {
        // The platform's paths are ASCII, and these titles are written in a script it cannot carry.
        // Numbering them (page, page-2, page-3) would destroy every URL the site had while reporting
        // nothing, so the route is asked for rather than invented.
        writeJson(join(workspace, 'inventory', 'untranslatable-routes.json'), urlPlan.erased);
        for (const page of urlPlan.erased.slice(0, 5)) console.log(`· no ASCII route for ${page.source ?? page.id}: ${page.segments.join(', ')}`);
        const message = `${urlPlan.erased.length} page(s) have no route the platform's slug rules can carry (see inventory/untranslatable-routes.json); set each page's "new" path in plan/urls.yaml and run plan again`;
        if ((s.fidelityMode ?? 'exact') === 'exact') fail(message);
        console.log(`· ${message}; permissive mode is numbering them instead`);
      }
      const assetsPlan = { provider: v.provider ?? s.target.assetProvider ?? 'local', generateAlt: false, iframeHosts: ['www.youtube.com', 'youtube.com', 'youtu.be', 'player.vimeo.com', 'www.loom.com'] };
      const ap = join(workspace, 'plan', 'assets.yaml'); if (!existsSync(ap)) writeFileSync(ap, toYaml(assetsPlan), { mode: 0o600 });
      // plans are pinned again by convert; a plan edit invalidates any verified output
      s.hashes.componentPlan = fileHash(planPath); s.hashes.urlPlan = fileHash(join(workspace, 'plan', 'urls.yaml')); s.hashes.canonicalOutput = undefined; writeSession(workspace, s);
      markStage(workspace, 'plan', 'done');
      const needs = components.filter((c) => c.status === 'needs-review').length;
      ok(`component plan: ${components.length} clusters, ${needs} need review; url plan: ${urlPlan.pages.length} pages (${urlPlan.mode})`);
      humanGate(2, 'conversion plan', 'review plan/component-plan.yaml, plan/urls.yaml, plan/assets.yaml and inventory/snippets.json; resolve every needs-review or blocked decision before conversion');
      break;
    }
    case 'assets': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'plan');
      const fidelityMode = s.fidelityMode ?? 'exact';
      const blockExclusions = readBlockExclusions(workspace);
      assertExclusionsPermitted(fidelityMode, blockExclusions);
      // permissive mode only: excluded blocks are not part of the migration, so their assets are neither fetched nor gated
      const docs = loadSnapshot(workspace).map((d) => applyBlockExclusions(d, blockExclusions));
      const assetPlanPath = join(workspace, 'plan', 'assets.yaml');
      const assetPlan = existsSync(assetPlanPath) ? (parseYaml(readFileSync(assetPlanPath, 'utf8')) as { provider?: string }) : {};
      const provider = v.provider ?? assetPlan.provider ?? s.target.assetProvider ?? 'local';
      if (!['none', 'local', 's3', 'dai-api'].includes(provider)) fail(`unsupported asset provider ${provider}`);
      // Asset CDNs are often cross-host. The Fetcher still rejects private
      // addresses and never sends source credentials across origins.
      const fetcher = new Fetcher(networkOptions(workspace, s));
      let localResolver: ((url: string) => string | undefined) | undefined;
      if (s.source.kind === 'export' && (s.source.platform === 'document360' || readTree(workspace).platform === 'document360')) {
        requireSourceManifest(workspace, s.hashes.sourceManifest);
        const exp = readD360Export(frozenRootPath(workspace));
        localResolver = d360MediaResolver(exp.mediaDir);
      }
      const providerOptions: AssetProviderOptions = {
        workspace,
        provider: provider as AssetProviderOptions['provider'],
        s3: provider === 's3' ? s3StorageFromEnv(process.env, s.target) : undefined,
        dai: provider === 'dai-api' ? { baseUrl: process.env.DAI_API_BASE ?? '', token: process.env.DAI_API_KEY ?? '' } : undefined,
      };
      if (provider === 's3') {
        const problems = s3StorageProblems(providerOptions.s3!);
        if (problems.length) fail(`s3 provider cannot write Documentation.AI media storage: ${problems.join('; ')}`);
        const unset = (['video', 'files'] as const).filter((kind) => !providerOptions.s3!.buckets[kind]?.bucket);
        if (unset.length) console.log(`· no ${unset.join(' or ')} bucket configured: those assets fail instead of landing in the image bucket`);
      }
      if (provider === 'dai-api' && Object.values(providerOptions.dai!).some((x) => !x)) fail('dai-api provider requires DAI_API_BASE and DAI_API_KEY (the key is bound to one documentation)');
      let result: AssetsStageResult;
      try {
        result = await runAssetsStage({ workspace, docs, fidelityMode, provider: providerOptions, fetcher, localResolver });
      } catch (error) {
        if (!(error instanceof UnhostedAssetsError)) throw error;
        markStage(workspace, 'assets', 'failed', `${error.entries.length} assets without a hosted URL`);
        fail(error.message);
      }
      const entries = Object.values(result.manifest.entries);
      markStage(workspace, 'assets', 'done');
      ok(`${entries.length} assets (${referenceTally(result.manifest) || 'no references'}) via ${provider}: ${entries.filter((e) => e.status === 'ingested').length} ingested, ${entries.filter((e) => e.status === 'downloaded').length} local, ${entries.filter((e) => e.status === 'kept-external').length} kept external, ${entries.filter((e) => e.status === 'failed').length} failed; ${entries.reduce((n, e) => n + e.altMissing, 0)} references without alt`);
      if (provider === 'local') console.log('· provider local: release remains blocked until dai-api or s3 assigns final URLs');
      break;
    }
    case 'convert': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'plan', 'assets');
      // Components a person recorded a substitution for; one decision covers every locale.
      const substitutedComponents = new Set<string>(readScopeDecisions(workspace).substituted.map((entry) => entry.component));
      const blockExclusions = readBlockExclusions(workspace);
      // exact mode carries every authored block; an operator exclusion is refused before anything is read or written
      if ((s.fidelityMode ?? 'exact') === 'exact' && blockExclusions.length) fail(`block exclusions are not permitted in exact mode: plan/block-exclusions.yaml lists ${blockExclusions.length} (${blockExclusions.map((e) => `${e.pageId}:${e.nodeId}`).join(', ')}); remove them, or re-run init with --fidelity permissive`);
      requireFrozenInputs(workspace, s);
      const tree = applyUrlPlan(readTree(workspace), readUrlPlan(workspace) ?? defaultUrlPlan(readTree(workspace)));
      // Streamed, not loaded: conversion writes one page at a time, and a large corpus held whole
      // is what a 5,000-page migration spends its memory on.
      const docs = snapshotPages(workspace);
      const pageCount = snapshotPageCount(workspace);
      const manifest = readManifest(workspace);
      const unmatchedExclusions = unmatchedBlockExclusions(docs, blockExclusions);
      if (unmatchedExclusions.length) fail(`plan/block-exclusions.yaml names nodes that are not in the snapshot: ${unmatchedExclusions.map((e) => `${e.pageId}:${e.nodeId}`).join(', ')}`);
      const plan = readComponentPlan(workspace);
      const assetsPlan = existsSync(join(workspace, 'plan', 'assets.yaml')) ? (parseYaml(readFileSync(join(workspace, 'plan', 'assets.yaml'), 'utf8')) as { iframeHosts?: string[] }) : {};
      // fresh ledger and log per convert run
      for (const f of ['ledger/dispositions.jsonl', 'logging/decisions.jsonl']) { const p = join(workspace, f); if (existsSync(p)) writeFileSync(p, ''); }
      const ledger = new Ledger(workspace); const log = new DecisionLog(workspace, !!v['log-originals']);
      const engine = new RulesEngine({ platform: tree.platform, mappings: loadMappings(mappingPaths(tree.platform)), plan, ledger, log, iframeHosts: assetsPlan.iframeHosts, flareData: frozenNavigationData(workspace) });
      // a link to another page follows it to its new route; one to a page this migration does not write is kept, or sent to
      // the source site when the URL plan says so, and listed in report/unmigrated-links.json
      const siteLinks = siteLinksForWorkspace(workspace, tree);
      const siteLink = siteLinkTarget(siteLinks);
      const resolveSiteLink = siteLinkResolver(siteLinks);
      const unmigratedLinks: Array<{ pageId: string; route: string; url: string; target: string; action: 'kept' | 'source'; knownSourcePage: boolean }> = [];
      const byId = new Map(tree.pages.map((p) => [p.id, p]));
      const snippets = existsSync(join(workspace, 'inventory', 'snippets.json')) ? readJson<Array<{ token: string; body: string | null; resolution: string }>>(join(workspace, 'inventory', 'snippets.json')) : [];
      const blockedTokens = new Set(snippets.filter((x) => x.resolution === 'blocked' && !x.body).map((x) => x.token));
      const outDir = join(workspace, 'output'); const qDir = join(workspace, 'quarantine');
      resetDir(outDir); resetDir(qDir);
      const anchors = existsSync(join(workspace, 'inventory', 'anchors.json')) ? readJson<Array<{ pageId: string; headings: Array<{ id: string; text: string; sourceId?: string }>; titleAnchor?: string }>>(join(workspace, 'inventory', 'anchors.json')) : [];
      const links = existsSync(join(workspace, 'inventory', 'links.json')) ? readJson<Array<{ pageId: string; url: string }>>(join(workspace, 'inventory', 'links.json')) : [];
      const inbound = new Map<string, number>();
      for (const l of links) { const h = fragmentOf(l.url); if (h) inbound.set(`#${h}`, (inbound.get(`#${h}`) ?? 0) + 1); }
      const { shims, leading: leadingAnchors } = anchorMap(anchors, inbound);
      let converted = 0; let heldForSnippets = 0; let quarantinedForFidelity = 0;
      // every snapshot page gets a record, so verify can tell a page convert skipped on purpose from one it never saw
      const fidelityRecords: FidelityRecord[] = [];
      // Endpoint pages state their operation through a spec. The fragments they carried are collected
      // here so each spec can be assembled below, and a link into an endpoint page's parameter is sent
      // to the anchor the platform renders for it rather than the one the source platform wrote.
      const operations: OpenApiOperationFragment[] = [];
      const anchorsByRoute = new Map<string, ReadonlySet<string>>();
      for (const snapshot of snapshotPages(workspace)) {
        if (!snapshot.openapiOperation) continue;
        operations.push(snapshot.openapiOperation);
        const route = byId.get(snapshot.pageId)?.newPath;
        if (route && snapshot.openapiOperation.document) anchorsByRoute.set(route, openapiAnchors(snapshot.openapiOperation.document, snapshot.openapiOperation.method, snapshot.openapiOperation.path));
      }
      const parameterLink = parameterLinkRewriter(anchorsByRoute);
      const convertProgress = progressReporter('converted', pageCount);
      for (const doc of docs) {
        const page = byId.get(doc.pageId);
        if (!page || !page.migrate || !page.newPath) { fidelityRecords.push(unconvertedFidelityRecord(doc, 'not-migrated')); continue; }
        const hasBlocked = [...blockedTokens].some((t) => JSON.stringify(doc.children).includes(`UNRESOLVED SNIPPET ${t}`) || JSON.stringify(doc.children).includes(`"token":"${t}"`));
        if (hasBlocked) {
          heldForSnippets++;
          walkBlocks(doc.children, (n) => { ledger.quarantined(doc.pageId, n.id, 'page held: blocked snippet token(s) unresolved'); });
          writeQuarantine(workspace, doc.pageId, { kind: 'blocked-snippet', reason: 'blocked snippet token(s) unresolved', page: page.newPath });
          fidelityRecords.push(unconvertedFidelityRecord(doc, 'held'));
          continue;
        }
        const sourcePrepared = applyDeclaredLosses(retargetDocLinks(rewriteAssetRefs(inlineSnippetBodies(doc, snippets), manifest), (url, source) => parameterLink(siteLink(url, source))), engine, substitutedComponents);
        const withSnippets = inlineSnippetBodies(applyBlockExclusions(doc, blockExclusions, ledger), snippets);
        const recordSiteLink = (url: string, source?: string): string => {
          const outcome = resolveSiteLink(url, source);
          if (outcome && outcome.kind !== 'route') unmigratedLinks.push({ pageId: doc.pageId, route: page.newPath!, url, target: outcome.target, action: outcome.kind, knownSourcePage: outcome.knownSourcePage });
          return outcome?.target ?? url;
        };
        const resolved = engine.resolveDoc(retargetDocLinks(rewriteAssetRefs(withSnippets, manifest), (url, source) => parameterLink(recordSiteLink(url, source))));
        const sourceSnapshot = authoredContentSnapshot(sourcePrepared);
        const resolvedSnapshot = authoredContentSnapshot(resolved);
        const pass = fidelityEqual(sourceSnapshot, resolvedSnapshot);
        const difference = pass ? undefined : firstFidelityDifference(sourceSnapshot, resolvedSnapshot);
        fidelityRecords.push({ pageId: doc.pageId, source: doc.source, pass, difference, sourceSnapshot, resolvedSnapshot, expectedOutput: renderedDocSnapshot(resolved) });
        if (!pass && (s.fidelityMode ?? 'exact') === 'exact') {
          quarantinedForFidelity++;
          writeQuarantine(workspace, doc.pageId, { kind: 'exact-fidelity', reason: `exact-fidelity violation at ${difference ?? 'unknown location'}`, page: page.newPath, sourceSnapshot, resolvedSnapshot });
          continue;
        }
        const mdx = docToMdx(resolved, { anchorShims: shims.get(doc.pageId), leadingAnchor: leadingAnchors.get(doc.pageId) });
        const outPath = join(outDir, `${page.newPath}.mdx`);
        mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
        writeFileSync(outPath, mdx, { mode: 0o600 });
        converted++;
        convertProgress(converted + heldForSnippets + quarantinedForFidelity);
      }
      writeFidelityRecords(workspace, fidelityRecords);
      // Each spec the endpoint pages named is assembled from their fragments and written where the
      // platform reads it. A spec a page named by URL is captured rather than assembled; one the
      // capture did not reach is listed, so its endpoint pages are not left pointing at nothing.
      for (const [spec, text] of mergeOperationDocuments(operations.filter((operation) => operation.document))) {
        const specPath = join(outDir, 'api-reference', spec);
        mkdirSync(dirname(specPath), { recursive: true, mode: 0o700 });
        writeFileSync(specPath, text, { mode: 0o600 });
      }
      const declaredByUrl = [...new Map(operations.filter((operation) => !operation.document).map((operation) => [operation.spec, operation.specUrl ?? operation.spec])).entries()];
      writeJson(join(workspace, 'report', 'openapi-declared.json'), declaredByUrl.map(([file, url]) => ({ file: `api-reference/${file}`, url })));
      const unresolvedSpecs = declaredByUrl.filter(([file]) => !existsSync(join(outDir, 'api-reference', file)));
      if (unresolvedSpecs.length) console.log(`· ${unresolvedSpecs.length} OpenAPI spec(s) that pages reference by URL are not in the output; supply them with acquire --openapi <url> so those endpoint pages render: ${unresolvedSpecs.slice(0, 3).map(([, url]) => url).join(', ')}`);
      writeJson(join(workspace, 'report', 'unmigrated-links.json'), unmigratedLinks);
      if (s.hashes.openapi) {
        const specs = join(workspace, 'inventory', 'openapi.json');
        if (fileHash(specs) !== s.hashes.openapi) fail('OpenAPI manifest changed after acquisition');
        writeSpecOutput(workspace, readJson<SpecManifest>(specs), outDir);
      }
      s.hashes.componentPlan = fileHash(join(workspace, 'plan', 'component-plan.yaml'));
      s.hashes.urlPlan = fileHash(join(workspace, 'plan', 'urls.yaml'));
      s.hashes.assetPlan = fileHash(join(workspace, 'plan', 'assets.yaml'));
      s.hashes.blockExclusions = existsSync(blockExclusionsPath(workspace)) ? fileHash(blockExclusionsPath(workspace)) : undefined;
      s.hashes.scopeDecisions = existsSync(scopeDecisionsPath(workspace)) ? fileHash(scopeDecisionsPath(workspace)) : undefined;
      s.hashes.canonicalOutput = undefined;
      writeSession(workspace, s);
      // determinism is proven by re-converting the same frozen inputs, not by re-reading the same files
      const outputHash = canonicalHash(outDir);
      const inputsKey = sha256([s.hashes.sourceManifest ?? '', s.hashes.acquisition ?? '', s.hashes.scopeDecisions ?? '', fileHash(join(workspace, 'plan', 'tree.yaml')), s.hashes.snapshot ?? '', s.hashes.componentPlan ?? '', s.hashes.urlPlan ?? '', s.hashes.assetPlan ?? '', s.hashes.blockExclusions ?? '', existsSync(join(workspace, 'plan', 'assets.json')) ? fileHash(join(workspace, 'plan', 'assets.json')) : ''].join('|'));
      s.hashes.previousConvertOutput = s.hashes.convertInputs === inputsKey ? s.hashes.convertOutput : undefined;
      s.hashes.convertInputs = inputsKey; s.hashes.convertOutput = outputHash; writeSession(workspace, s);
      markStage(workspace, 'convert', 'done', `${converted} converted, ${heldForSnippets} held (blocked snippet tokens), ${quarantinedForFidelity} quarantined (exact-fidelity)`);
      ok(`${converted} pages written to output/, ${heldForSnippets} pages held (blocked snippet tokens), ${quarantinedForFidelity} pages quarantined (exact-fidelity)`);
      break;
    }
    case 'nav': {
      const workspace = ws(); const s = readSession(workspace); requireStages(s, 'convert');
      requireFrozenInputs(workspace, s);
      const tree = applyUrlPlan(readTree(workspace), readUrlPlan(workspace) ?? defaultUrlPlan(readTree(workspace)));
      const docJsonPath = join(workspace, 'output', 'documentation.json');
      const existing = existsSync(docJsonPath) ? readJson<Record<string, unknown>>(docJsonPath) : { name: 'Documentation', initialRoute: tree.pages.find((p) => p.migrate && p.newPath)?.newPath ?? '' };
      const meta = readPlatformMeta(workspace);
      // the connected specs ship with the output; a reference the source repository cannot satisfy stops the stage instead of leaving the group without its API
      for (const ref of meta.openapiCaptured ? [] : meta.openapi ?? []) {
        const group = ref.groupPath.join(' / ');
        if (!meta.root) fail(`openapi spec ${ref.spec} for group ${group}: inventory/platform-meta.json records no source repository root to read it from`);
        const root = frozenRootPath(workspace); const src = resolve(root, ref.spec);
        if (!src.startsWith(join(root, '/'))) fail(`openapi spec ${ref.spec} for group ${group} points outside the source repository`);
        if (!existsSync(src)) fail(`openapi spec ${ref.spec} for group ${group} is not in the source repository at ${root}; fix the reference in inventory/platform-meta.json or restore the file`);
        const dst = join(workspace, 'output', specOutputPath(ref.spec)); mkdirSync(dirname(dst), { recursive: true, mode: 0o700 }); writeFileSync(dst, readFileSync(src), { mode: 0o600 });
      }
      // A page the source placed but the output does not would disappear from the sidebar without a word.
      const unplaced = pagesWithoutPlacement(tree).filter((page) => page.navMembership !== 'unlisted');
      if (unplaced.length && (s.fidelityMode ?? 'exact') === 'exact') {
        fail(`${unplaced.length} migrated page(s) have no placement in the source navigation and are not marked unlisted:\n${unplaced.map((page) => `  ${page.source} (${page.id})`).join('\n')}\nre-run discover so the navigation covers them, mark them unlisted in plan/tree.yaml, or re-run init with --fidelity permissive`);
      }
      const unlisted = pagesWithoutPlacement(tree).filter((page) => page.navMembership === 'unlisted');
      // The renderer serves only routes the navigation names, so a page written as a file and left
      // out of it answers 404. Placing those pages states a structure the source's sidebar does not,
      // so it is an operator's decision: it records who made it and marks the navigation reviewed,
      // which is the same footing as a tree recovered by hand.
      if (v['place-unlisted']) {
        const by = (v.by ?? '').trim();
        if (!by) fail('--place-unlisted needs --by "<who>": placing pages the source never placed is a decision that records its approver');
        if (!unlisted.length) fail('--place-unlisted was given, but the source navigation already places every migrated page');
        tree.unlistedPlacement = { strategy: 'source-path', approvedBy: by, approvedAt: new Date().toISOString() };
        tree.navigationSource = 'manual';
        writeTree(workspace, tree);
        ok(`${unlisted.length} page(s) the source never placed will be grouped under the folders it publishes them in, by ${by}; navigation is now operator-reviewed, so approve gate 1 again`);
      }
      if (v['help-center']) {
        const by = (v.by ?? '').trim();
        const container = String(v['help-center']).trim();
        if (!by) fail('--help-center needs --by "<who>": a hub page the source never had is a decision that records its approver');
        if (!tree.navigation?.length) fail('--help-center needs the navigation the source states; this tree records none');
        const hubPath = (v['hub-path'] ? String(v['hub-path']) : defaultHubPath(container)).replace(/^\/+|\/+$/g, '');
        if (tree.pages.some((page) => page.migrate && page.newPath === hubPath)) fail(`--help-center: a migrated page already lives at ${hubPath}; name another route with --hub-path`);
        // The container must exist before anything is recorded: build the navigation once to find it.
        const preview = buildDocumentationNavigation({ ...tree, helpCenter: undefined }, writtenPagePaths(workspace, tree), meta);
        try { attachHelpCenterHub(preview.navigation, { container, hubPath }); } catch (error) { fail(`--help-center: ${(error as Error).message}`); }
        tree.helpCenter = { container, hubPath, approvedBy: by, approvedAt: new Date().toISOString() };
        writeTree(workspace, tree);
        ok(`${container} opens on a help-centre hub at ${hubPath}, its categories drawn from its own navigation, by ${by}; the tree changed, so approve gate 1 again`);
      }
      if (tree.helpCenter) {
        // The hub is written on every nav run, because convert rebuilds the output it lives in.
        const preview = buildDocumentationNavigation({ ...tree, helpCenter: undefined }, writtenPagePaths(workspace, tree), meta);
        const { nodePath } = attachHelpCenterHub(preview.navigation, tree.helpCenter);
        const hubFile = join(workspace, 'output', `${tree.helpCenter.hubPath}.mdx`);
        mkdirSync(dirname(hubFile), { recursive: true, mode: 0o700 });
        writeFileSync(hubFile, helpCenterHubMdx(tree.helpCenter, nodePath), { mode: 0o600 });
      }
      const navigation = buildDocumentationNavigation(tree, writtenPagePaths(workspace, tree), meta);
      // The documentation's name travels with it; the source's logo, favicon, colours and theme do not,
      // so the migrated site shows Documentation.AI's own branding.
      const site = documentationSiteSettings(meta);
      // initialRoute is a page path without a leading slash; normalise values written by earlier runs
      const initialRoute = typeof existing.initialRoute === 'string' ? existing.initialRoute.replace(/^\/+/, '') : undefined;
      // An earlier run may have carried source branding into this file; it must not survive a re-run.
      writeJson(docJsonPath, { ...withoutSourceBranding(existing), ...(initialRoute ? { initialRoute } : {}), ...site, ...navigation });
      const plan = readUrlPlan(workspace)!;
      const r = redirectMaps(plan);
      const platformExact = (meta.redirects?.exact ?? []).filter((x) => !r.exact.some((e) => e.source === x.source));
      const platformWildcard = (meta.redirects?.wildcard ?? []).filter((x) => !r.wildcard.some((e) => e.source === x.source));
      r.exact.push(...platformExact); r.wildcard.push(...platformWildcard);
      writeJson(join(workspace, 'report', 'redirects.exact.json'), r.exact);
      writeJson(join(workspace, 'report', 'redirects.wildcard.json'), r.wildcard);
      if (meta.openapi?.length) console.log(`· copied ${meta.openapi.length} OpenAPI spec(s) into output and attached them to their groups`);
      const anchors = existsSync(join(workspace, 'inventory', 'anchors.json')) ? readJson<Array<{ pageId: string; headings: Array<{ id: string; text: string; sourceId?: string }>; titleAnchor?: string }>>(join(workspace, 'inventory', 'anchors.json')) : [];
      const links = existsSync(join(workspace, 'inventory', 'links.json')) ? readJson<Array<{ pageId: string; url: string }>>(join(workspace, 'inventory', 'links.json')) : [];
      const inbound = new Map<string, number>();
      for (const l of links) { const h = fragmentOf(l.url); if (h) inbound.set(`#${h}`, (inbound.get(`#${h}`) ?? 0) + 1); }
      const am = anchorMap(anchors, inbound);
      writeJson(join(workspace, 'report', 'anchors.json'), am.entries);
      if (unlisted.length) writeJson(join(workspace, 'report', 'unlisted-pages.json'), unlisted.map((page) => ({ id: page.id, source: page.source, newPath: page.newPath, title: page.title, reason: page.reason })));
      markStage(workspace, 'nav', 'done');
      ok(`documentation.json written; ${r.exact.length} exact redirects, ${r.wildcard.length} wildcard candidates, ${r.issues.length} issues; ${am.entries.filter((e) => e.needsShim).length} headings need anchor shims`);
      if (unlisted.length) console.log(`· ${unlisted.length} page(s) the source publishes without a sidebar placement were migrated as files and listed in report/unlisted-pages.json`);
      console.log('· navigation artifacts are ready; run local verify before requesting human gate 3');
      break;
    }
    case 'write': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'nav');
      // exact output never points at a source host: a manifest that lost a hosted URL since the assets stage refuses the branch
      if ((s.fidelityMode ?? 'exact') === 'exact') assertAssetsHosted(readManifest(workspace), 'write');
      const remote = v.remote ?? s.target.repoRemote;
      const repoDir = v.repo ? resolve(v.repo) : join(workspace, 'repo');
      if (!v.repo && !remote) fail('--repo <dir> or a remote (from init --remote or --remote here) is required');
      if (!v.repo) mkdirSync(repoDir, { recursive: true, mode: 0o700 }); // cloned by the writer on first use
      if (v['allow-lossy'] && !v.push) fail('--allow-lossy only changes what --push accepts; without --push no gate is consulted');
      if (v.push) {
        requireFrozenInputs(workspace, s);
        // Nothing reaches the customer's repository unapproved: scope, decisions and the output
        // itself each carry a recorded approval of the exact state being pushed.
        const unapproved = releaseApprovalProblems(workspace, s, 3);
        if (unapproved.length) fail(`--push refused until the human gates are approved:\n${unapproved.map((problem) => `  ${problem}`).join('\n')}\napprove with: dai-migrate approve --gate <n> --by "<who approved it>"`);
        const gateFile = join(workspace, 'report', 'gates.json');
        if (!existsSync(gateFile)) fail('--push requires a completed verify run');
        const currentOutputHash = canonicalHash(join(workspace, 'output'));
        if (!s.hashes.canonicalOutput || currentOutputHash !== s.hashes.canonicalOutput) fail('--push refused: output changed after deterministic verification; rerun verify twice');
        const pinnedPlans = [
          ['component-plan.yaml', s.hashes.componentPlan],
          ['urls.yaml', s.hashes.urlPlan],
          ['assets.yaml', s.hashes.assetPlan],
        ] as const;
        const stalePlans: string[] = pinnedPlans.filter(([file, expected]) => !expected || !existsSync(join(workspace, 'plan', file)) || fileHash(join(workspace, 'plan', file)) !== expected).map(([file]) => file);
        // block exclusions are optional, so pin presence as well as content
        if ((existsSync(blockExclusionsPath(workspace)) ? fileHash(blockExclusionsPath(workspace)) : undefined) !== s.hashes.blockExclusions) stalePlans.push('block-exclusions.yaml');
        if ((existsSync(scopeDecisionsPath(workspace)) ? fileHash(scopeDecisionsPath(workspace)) : undefined) !== s.hashes.scopeDecisions) stalePlans.push('scope-decisions.yaml');
        if (stalePlans.length) fail(`--push refused: plan changed after conversion (${stalePlans.join(', ')}); rerun convert and verify`);
        const gateReport = readJson<{ pass: boolean; outputHash?: string; gates: GateResult[] }>(gateFile);
        if (gateReport.outputHash !== currentOutputHash) fail('--push refused: report/gates.json does not belong to the current output; rerun verify');
        // An exploratory push accepts that exactness is unproven, which only a permissive session can
        // leave it. It waives "not proven", never a gate that actually failed.
        const allowLossy = !!v['allow-lossy'];
        if (allowLossy && (s.fidelityMode ?? 'exact') === 'exact') fail('--allow-lossy refused: this session is exact, where nothing is left unproven and nothing may be waived. Re-run init with --fidelity permissive for an exploratory migration.');
        const blockers = previewPushBlockers(gateReport.gates, { allowUnprovenExactness: allowLossy });
        if (blockers.length) fail(`--push refused: non-preview gates must pass first (${blockers.map((g) => g.id).join(', ')})${allowLossy ? '; these failed or are missing, which --allow-lossy cannot waive' : ''}`);
        if (allowLossy) {
          const waived = waivedExactnessGates(gateReport.gates).map((gate) => gate.id);
          writeJson(join(workspace, 'report', 'lossy-push.json'), { at: new Date().toISOString(), outputHash: currentOutputHash, waivedGates: waived });
          console.log(`· EXPLORATORY PUSH: ${waived.length} exactness gate(s) waived as unproven (${waived.join(', ')}); recorded in report/lossy-push.json`);
          console.log('· this branch is NOT a certified migration: its preview may differ from the source and it must not be released to a customer');
        }
        if (!gateReport.pass) console.log('· pushing the migration branch to create a preview; rendered-preview gates remain required before release');
      }
      const allowed = existsSync(join(workspace, 'plan', 'allowed-orgs.json')) ? readJson<string[]>(join(workspace, 'plan', 'allowed-orgs.json')) : [];
      if (v.push && remote) {
        // cheap and side-effect free; turns a cryptic git failure after a full build into a one-line fix
        const probe = await probePushAccess(remote);
        if (!probe.ok) fail(`cannot push to ${remote}: ${probe.detail}. Fix: ${probe.fix}. The branch can still be written locally without --push.`);
      }
      // A migration branch is evidence of what was pushed and is never rewritten. A build corrected
      // after the rendered preview showed something — which is what gate 4 is for — is a new
      // revision of the same migration: it takes a new id, and every branch already reviewed stays
      // exactly as it was.
      if (v.revision !== undefined) {
        const reason = String(v.revision).trim();
        if (!reason) fail('--revision needs the reason this build supersedes the last push, e.g. --revision "the preview showed unlisted pages answering 404"');
        const previous = s.migrationId;
        Object.assign(s, recordRevision(s, reason, newMigrationId()));
        writeSession(workspace, s);
        ok(`revision ${s.migrationId} supersedes ${previous}: ${reason}; the earlier branch and its preview are left untouched`);
      }
      const r = writeMigrationBranch({ repoDir, outputDir: join(workspace, 'output'), sessionId: s.migrationId, remote, allowedRemoteOrgs: allowed, push: !!v.push });
      s.target.repoRemote = remote ?? s.target.repoRemote; writeSession(workspace, s);
      markStage(workspace, 'write', 'done', `${r.branch}@${r.commit.slice(0, 8)}`);
      ok(`${r.branch} at ${r.commit.slice(0, 8)}${r.pushed ? ' (pushed)' : ' (not pushed; add --push)'}`);
      // After a push the platform's webhook builds a preview; find it so the operator never has to hunt for the URL.
      if (r.pushed && !v['no-wait']) {
        if (!process.env.DAI_API_KEY || !s.target.apiBase) console.log('· DAI_API_KEY not configured: cannot discover the preview URL; read it from the dashboard Deployments → Preview tab and pass --preview-url to verify');
        else {
          const api = new DaiClient({ baseUrl: s.target.apiBase, apiKey: process.env.DAI_API_KEY });
          const minutes = Number(v['preview-timeout']);
          if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) fail('--preview-timeout must be 1..120 minutes');
          console.log(`· waiting up to ${minutes} min for the preview deployment of ${r.branch}`);
          let last = '';
          const res = await api.waitForBranchDeployment(r.branch, { timeoutMs: minutes * 60_000, onTick: (d) => { const st = d ? `${d.status}${d.url ? ` ${d.url}` : ''}` : 'no deployment yet'; if (st !== last) { console.log(`  · ${st}`); last = st; } } });
          if (res.outcome === 'ready' && res.deployment?.url) {
            s.target.previewUrl = res.deployment.url.startsWith('http') ? res.deployment.url : `https://${res.deployment.url}`;
            s.target.previewDeploymentId = res.deployment.deploymentId; s.target.previewsSeen = true; writeSession(workspace, s);
            ok(`preview ready: ${s.target.previewUrl}`);
            console.log(`  next: dai-migrate verify --workspace ${workspace} --preview`);
          } else if (res.outcome === 'error' || res.outcome === 'cancelled') {
            fail(`preview deployment ${res.deployment?.deploymentId ?? ''} ended with status ${res.outcome}; open it in the dashboard Deployments list for the build log`);
          } else if (res.firstSeenMs !== undefined) {
            fail(`preview deployment for ${r.branch} was created but did not reach ready within ${minutes} min; re-run verify --preview-url <url> once the dashboard shows it ready`);
          } else {
            fail(noDeploymentDiagnosis(r.branch, !!s.target.previewsSeen));
          }
        }
      }
      break;
    }
    case 'verify': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'nav');
      const tree = applyUrlPlan(readTree(workspace), readUrlPlan(workspace) ?? defaultUrlPlan(readTree(workspace)));
      // Streamed rather than loaded: verification looks at one page at a time, and holding every
      // parsed page to do that is where a large migration spends its memory.
      const docs = snapshotPages(workspace);
      const byId = new Map(tree.pages.map((p) => [p.id, p]));
      const qDir = join(workspace, 'quarantine');
      const quarantined = new Set(existsSync(qDir) ? readdirSync(qDir).map((f) => f.replace(/\.json$/, '')) : []);
      const plan = readComponentPlan(workspace);
      const unreviewed = Object.values(plan).filter((c) => c.status === 'needs-review' || ((c.tier === 'T5' || c.tier === 'T6') && c.status !== 'approved' && c.status !== 'excluded' && c.status !== 'quarantined')).length;
      // preview URL: explicit flag, else the one write --push discovered
      const previewUrl = v['preview-url'] ?? (v.preview ? s.target.previewUrl : undefined);
      if (v.preview && !previewUrl) fail('--preview requested but no preview URL is recorded; run write --push first or pass --preview-url');
      // contract version: explicit flag, else read live from the platform, else assume the pinned version and say so
      let previewContractVersion = v['preview-contract-version'];
      let contractAssumed = false;
      if (previewUrl && !previewContractVersion) {
        if (process.env.DAI_API_KEY && s.target.apiBase) {
          try { previewContractVersion = (await new DaiClient({ baseUrl: s.target.apiBase, apiKey: process.env.DAI_API_KEY }).config()).contentContractVersion; } catch { /* fall through to assumption */ }
        }
        if (!previewContractVersion) { previewContractVersion = s.versions.contentContract; contractAssumed = true; }
      }
      // What the source itself served, re-read from the freeze: the gates compare output against
      // this, never only against the snapshot the same run produced.
      // Evidence is built for every source kind: a repository and an export froze their bytes too,
      // and certifying only live sites left the sources a customer migration most often uses unproven.
      // The same rules convert applied: the source is compared as the operator approved it, so a
      // declared loss (a dropped chrome subtree, an unwrapped wrapper's props, a prop the contract
      // cannot express) is not re-reported here as a difference from the source.
      const verifyEngine = new RulesEngine({
        platform: tree.platform, mappings: loadMappings(mappingPaths(tree.platform)), plan: readComponentPlan(workspace),
        ledger: new Ledger(join(workspace, 'plan')), log: new DecisionLog(join(workspace, 'plan')), flareData: frozenNavigationData(workspace),
        iframeHosts: existsSync(join(workspace, 'plan', 'assets.yaml')) ? (parseYaml(readFileSync(join(workspace, 'plan', 'assets.yaml'), 'utf8')) as { iframeHosts?: string[] }).iframeHosts : undefined,
      });
      const sourceEvidence = buildSourceEvidence(workspace, tree);
      if (sourceEvidence) sourceEvidence.declaredLosses = (d) => applyDeclaredLosses(d, verifyEngine);
      const gates = runGates({
        workspace, outputDir: join(workspace, 'output'), sourceEvidence, pinnedSourceManifest: s.hashes.sourceManifest, pinnedAcquisition: s.hashes.acquisition, pinnedOpenapi: s.hashes.openapi,
        // Gate 3 approves the report this run produces, so a local verify asks for gates 1 and 2;
        // by preview time the output has been approved and pushed, so gate 3 must hold too.
        approvalProblems: releaseApprovalProblems(workspace, s, v.preview ? 3 : 2),
        pinnedPlans: { componentPlan: s.hashes.componentPlan, urlPlan: s.hashes.urlPlan, assetPlan: s.hashes.assetPlan, blockExclusions: s.hashes.blockExclusions, scopeDecisions: s.hashes.scopeDecisions },
        sourceDocs: { *[Symbol.iterator]() { for (const doc of docs) yield { doc, outputFile: byId.get(doc.pageId)?.newPath ? join(workspace, 'output', `${byId.get(doc.pageId)!.newPath}.mdx`) : undefined }; } },
        treePages: tree.pages, quarantinedPages: quarantined, excludedPages: new Set(), unreviewed,
        previousCanonicalHash: s.hashes.previousConvertOutput, convertOutputHash: s.hashes.convertOutput, previewUrl, pinnedContractVersion: s.versions.contentContract, previewContractVersion,
        fidelityMode: s.fidelityMode ?? 'exact', sourceKind: s.source.kind, navigationSource: tree.navigationSource,
        pinnedMigrator: s.migrator, currentMigrator: captureMigratorProvenance({ repoRoot: PLUGIN_ROOT, packageVersion: CORE_VERSION }),
        expectedNavigation: buildDocumentationNavigation(tree, writtenPagePaths(workspace, tree), readPlatformMeta(workspace)).navigation,
      });
      if (previewUrl) {
        if (contractAssumed) {
          const g = gates.find((x) => x.id === 'preview-contract-version');
          if (g) g.detail = `assumed: the platform does not expose contentContractVersion; pinned ${s.versions.contentContract} used (recorded in the report)`;
          s.target.contractVersionAssumed = true; writeSession(workspace, s);
        }
        const anchorFile = join(workspace, 'report', 'anchors.json');
        const browserAnchors = existsSync(anchorFile) ? readJson<BrowserAnchor[]>(anchorFile) : [];
        // One browser for the whole preview check, and one render per route shared by both gates.
        // Each gate used to launch its own Chrome for every page, so the same page was fetched,
        // rendered and thrown away twice. The render opens accordions, expandables and tabs first,
        // so the content behind them is verified instead of excused.
        const preview = await openChromeSession(previewUrl, { concurrency: Number(v.concurrency) });
        const renderPreview = cachedRenderer(preview.render, { prepare: EXPAND_INTERACTIVE });
        try {
        const browserConcurrency = Number(v.concurrency);
        const browser = await runBrowserFragmentGate(previewUrl, tree.pages, browserAnchors, renderPreview, browserConcurrency);
        const index = gates.findIndex((g) => g.id === 'browser-fragments');
        if (index >= 0) gates[index] = browser; else gates.push(browser);
        // The preview is compared against the raw source, not against the snapshot: the same
        // standard the local gates apply, on the deployed page.
        const rawByPageId = new Map((sourceEvidence?.pages ?? []).map((page) => [page.pageId, page]));
        const previewSiteLink = siteLinkTarget(siteLinksForWorkspace(workspace, tree));
        const manifest = readManifest(workspace);
        const browserContent = await runBrowserContentGate(
          previewUrl,
          tree.pages.map((page) => {
            const raw = rawByPageId.get(page.id);
            const fromSource = raw && sourceEvidence ? rawSourceIr(raw, sourceEvidence.platform, sourceEvidence.profile, sourceEvidence.links) : undefined;
            const snapshot = readSnapshotPage(workspace, page.id);
            return { ...page, doc: fromSource ?? (snapshot && retargetDocLinks(snapshot, previewSiteLink)) };
          }),
          {
            routes: writtenPagePaths(workspace, tree),
            assetUrls: new Map(Object.entries(manifest.byUrl).flatMap(([url, hash]) => { const final = manifest.entries[hash]?.finalUrl; return final ? [[url, final] as [string, string]] : []; })),
            navigation: expectedSidebar(tree),
            navSelector: DAI_PREVIEW_NAV_SELECTOR,
            contentSelectors: DAI_PREVIEW_CONTENT_SELECTORS,
            siteName: typeof readPlatformMeta(workspace).name === 'string' ? readPlatformMeta(workspace).name : undefined,
            render: renderPreview,
            interactive: true,
            concurrency: browserConcurrency,
          },
        );
        const contentIndex = gates.findIndex((g) => g.id === 'browser-content');
        if (contentIndex >= 0) gates[contentIndex] = browserContent.gate; else gates.push(browserContent.gate);
        writeJson(join(workspace, 'report', 'preview-routes.json'), browserContent.routes);
        // The same pages on a phone, a tablet and a desktop: documentation is read on all three,
        // and a page that spills off the side of a phone passes every content check there is.
        const responsive = await runResponsiveGate(browserContent.routes.filter((result) => result.route !== '(site)').map((result) => ({ route: result.route, url: routeUrl(previewUrl, result.route) })), preview, undefined, browserConcurrency);
        writeJson(join(workspace, 'report', 'responsive.json'), responsive.readings);
        const responsiveIndex = gates.findIndex((g) => g.id === 'responsive-layout');
        if (responsiveIndex >= 0) gates[responsiveIndex] = responsive.gate; else gates.push(responsive.gate);
        } finally {
          await preview.close();
        }
      }
      const outputHash = canonicalHash(join(workspace, 'output'));
      writeGates(workspace, gates, outputHash, previewUrl ? ['gates.json', 'preview-gates.json'] : ['gates.json', 'pre-push-gates.json']);
      const clusters = existsSync(join(workspace, 'inventory', 'components.json')) ? readJson<ClusterEntry[]>(join(workspace, 'inventory', 'components.json')) : [];
      writeReviewQueue(workspace, gates, clusters, Object.fromEntries(Object.entries(plan).map(([k, c]) => [k, c.status ?? 'auto'])));
      if (!s.hashes.canonicalOutput) { s.hashes.canonicalOutput = canonicalHash(join(workspace, 'output')); writeSession(workspace, s); }
      for (const g of gates) console.log(`  ${g.status === 'pass' ? '✔' : g.status === 'fail' ? '✖' : '·'} ${g.id}: ${g.detail}`);
      const blocked = gates.filter((g) => !gateSatisfied(g)).length;
      const prePushBlockers = previewPushBlockers(gates);
      const effectiveBlockers = previewUrl ? blocked : prePushBlockers.length;
      markStage(workspace, 'verify', effectiveBlockers ? 'failed' : 'done', previewUrl ? `${blocked} release gates failing or not run` : `${prePushBlockers.length} pre-push gates failing`);
      if (previewUrl) {
        if (blocked) console.log(`✖ ${blocked} release gate(s) failing or not run; release is blocked; see report/review-queue.md`);
        else {
          ok('all automated release gates pass');
          humanGate(4, 'preview and release', 'review the rendered preview, redirects and report; explicitly approve cutover/release');
        }
      } else if (prePushBlockers.length) {
        console.log(`✖ ${prePushBlockers.length} pre-push gate(s) failing; preview push is blocked; see report/review-queue.md`);
      } else {
        ok('all pre-push automated gates pass; preview-only gates remain not-run');
        humanGate(3, 'pre-push validation', 'review output/documentation.json, converted pages, redirects and report/review-queue.md; approve only the named migration-branch push');
      }
      if (effectiveBlockers) process.exitCode = 2;
      break;
    }
    case 'release': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'write', 'verify');
      const approvalProblems = releaseApprovalProblems(workspace, s, 4);
      if (approvalProblems.length) fail(`release refused until all four human gates approve their current immutable evidence:\n${approvalProblems.map((problem) => `  ${problem}`).join('\n')}`);
      const previewReportPath = join(workspace, 'report', 'preview-gates.json');
      if (!existsSync(previewReportPath)) fail('release refused: report/preview-gates.json is missing; run verify --preview and approve gate 4');
      const previewReport = readJson<{ pass: boolean; outputHash?: string; gates: GateResult[] }>(previewReportPath);
      const currentOutputHash = canonicalHash(join(workspace, 'output'));
      const automatedBlockers = releaseBlockers(previewReport.gates);
      if (!previewReport.pass || automatedBlockers.length) fail(`release refused: the rendered-preview report is incomplete or has unresolved gates (${automatedBlockers.map((gate) => gate.id).join(', ')})`);
      if (previewReport.outputHash !== currentOutputHash) fail('release refused: output changed after rendered-preview verification; rerun verification and approvals');
      const certificate = {
        schemaVersion: 1,
        at: new Date().toISOString(),
        migrationId: s.migrationId,
        outputHash: currentOutputHash,
        previewUrl: s.target.previewUrl,
        migrationCommit: s.stages.write?.note,
        previewReportHash: fileHash(previewReportPath),
        approvals: s.approvals,
      };
      writeJson(join(workspace, 'report', 'release-certificate.json'), certificate);
      markStage(workspace, 'release', 'done', `${currentOutputHash.slice(0, 12)} approved by all four human gates`);
      ok(`release certificate written for ${currentOutputHash.slice(0, 12)}; cutover is authorised for the pinned preview and output`);
      break;
    }
    case 'report': {
      const workspace = ws(); const s = readSession(workspace);
      const tree = applyUrlPlan(readTree(workspace), readUrlPlan(workspace) ?? defaultUrlPlan(readTree(workspace)));
      const gates = existsSync(join(workspace, 'report', 'gates.json')) ? readJson<{ gates: any[] }>(join(workspace, 'report', 'gates.json')).gates : [];
      const clusters = existsSync(join(workspace, 'inventory', 'components.json')) ? readJson<ClusterEntry[]>(join(workspace, 'inventory', 'components.json')) : [];
      const manifest = readManifest(workspace);
      const decisions = readDecisions(workspace);
      const shims = existsSync(join(workspace, 'report', 'anchors.json')) ? readJson<Array<{ needsShim: boolean }>>(join(workspace, 'report', 'anchors.json')).filter((a) => a.needsShim).length : 0;
      writePlatformGaps(workspace, decisions, shims);
      const provenance: RunProvenance = { fidelityMode: s.fidelityMode ?? 'exact', navigationSource: tree.navigationSource, migrator: s.migrator, quarantine: countQuarantine(workspace) };
      writeConnectionSummary(workspace, s, provenance);
      writeSummary(workspace, { pages: tree.pages.filter((p) => p.migrate).length, converted: tree.pages.filter((p) => p.migrate && p.newPath && existsSync(join(workspace, 'output', `${p.newPath}.mdx`))).length, clusters: clusters.length, assets: Object.keys(manifest.entries).length, gates, branch: s.stages.write?.note, provenance });

      // The one report written for the customer rather than the team: what arrived, what did not,
      // and what still needs them. Always written as HTML; the PDF is the same page printed.
      const redirectsPath = join(workspace, 'report', 'redirects.exact.json');
      const redirects = existsSync(redirectsPath) ? readJson<unknown[]>(redirectsPath).length : 0;
      const customer = buildCustomerReport({ workspace, session: s, tree, gates, assets: Object.keys(manifest.entries).length, redirects });
      const customerHtml = renderCustomerReportHtml(customer);
      const htmlPath = join(workspace, 'report', 'customer-report.html');
      writeFileSync(htmlPath, customerHtml, { mode: 0o600 });
      writeJson(join(workspace, 'report', 'customer-report.json'), customer);
      let pdfNote = '';
      if (v['no-pdf']) pdfNote = '; PDF skipped (--no-pdf)';
      else {
        const pdfPath = join(workspace, 'report', 'customer-report.pdf');
        try { await htmlToPdf(customerHtml, pdfPath); pdfNote = `; ${pdfPath}`; }
        catch (error) {
          // A missing browser must not cost the report: the HTML prints to PDF from any browser.
          const why = error instanceof ChromeUnavailableError ? error.message : `PDF rendering failed: ${(error as Error).message}`;
          pdfNote = `; PDF not written (${why}) — open ${htmlPath} and print to PDF, or set CHROME_PATH and re-run report`;
        }
      }
      markStage(workspace, 'report', 'done');
      ok('report/summary.md and report/platform-gaps.json written');
      const needsCustomer = customer.shortfalls.filter((shortfall) => shortfall.needsYou).length;
      ok(`customer report: ${customer.migrated.pagesWritten}/${customer.migrated.pagesInScope} pages, ${customer.shortfalls.length} item(s) that did not carry over${needsCustomer ? `, ${needsCustomer} needing a customer decision` : ''}${pdfNote}`);
      break;
    }
    default: fail(`unknown command ${cmd}\n\n${HELP}`);
  }
}

/**
 * One run owns the workspace while a command is running. A second run would read the same session,
 * do different work and write its own pins over the first, leaving a workspace that describes
 * neither. The lock lives beside the workspace, so even two simultaneous `init` commands for a
 * directory that does not exist yet cannot both claim it.
 */
const lockedWorkspace = v.workspace ? resolve(v.workspace) : undefined;
let workspaceLock: WorkspaceLock | undefined;
if (lockedWorkspace && cmd === 'init') assertOutsidePlugin(lockedWorkspace, PLUGIN_ROOT);
try { workspaceLock = lockedWorkspace ? acquireWorkspaceLock(lockedWorkspace, cmd ?? 'unknown') : undefined; }
catch (error) { fail((error as Error).message); }
if (workspaceLock?.tookOver) console.log(`· took over the workspace lock left by pid ${workspaceLock.tookOver.pid} ("${workspaceLock.tookOver.command}"), which is no longer running`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { workspaceLock?.release(); process.exit(130); });
process.once('exit', () => workspaceLock?.release());

main()
  .then(() => workspaceLock?.release())
  .catch((e) => { workspaceLock?.release(); fail((e as Error).message); });
