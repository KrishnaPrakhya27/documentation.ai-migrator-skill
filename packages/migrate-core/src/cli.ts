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
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { Cookie, CookieJar } from 'tough-cookie';
import { loadContract } from '@dai/content-contract';
import { freezeDirectory, frozenRootPath, sourceManifestPath, writeSourceManifest, type SourceManifest, type FreezeResult } from './evidence/manifest.js';
import { nativeSourceManifest, liveSourceManifest } from './evidence/capture.js';
import { requireSourceManifest } from './evidence/verify.js';
import { pinAcquisition, requireAcquisition } from './evidence/acquisition.js';
import { ensureScopeDecisionsFile, scopeDecisionsPath } from './evidence/scope.js';
import { captureSpecGraph, writeSpecOutput, type SpecManifest } from './openapi/graph.js';
import { readmeCatalogSpecs } from './openapi/readme.js';
import { assertOutsidePlugin, ensureWorkspace, readSession, writeSession, markStage, type Session, fileHash } from './session/workspace.js';
import { newMigrationId, pageIdFromPlatform, sha256 } from './session/ids.js';
import { captureMigratorProvenance } from './session/provenance.js';
import { countQuarantine, writeQuarantine } from './session/quarantine.js';
import { preflight, probePushAccess } from './session/preflight.js';
import { DaiClient, noDeploymentDiagnosis } from './session/platform.js';
import { fingerprint } from './scrape/fingerprint.js';
import { CanonicalHosts, Fetcher, type FetchOptions } from './scrape/fetcher.js';
import { Firecrawl, readFirecrawlPage, type FirecrawlOptions } from './scrape/firecrawl.js';
import { getProfile, htmlAdapterOptions, profileHostAliases, type ScrapeProfile } from './scrape/profiles.js';
import { discoverLiveSite, extractDomSidebarNavigation, extractMintlifyNavigation, extractSectionTabs, sectionOfUrl, siteSectionNavigation, type DiscoveredNavigationNode } from './scrape/discovery.js';
import { unwrapPublishedMarkdown } from './scrape/published-markdown.js';
import { acquirePages, acquireFirecrawlPages, acquiredPath, type AcquiredPage } from './scrape/acquire.js';
import { htmlToIr } from './ir/from-html.js';
import { markdownToIr } from './ir/from-markdown.js';
import { extractIfZip, readD360Export, d360ArticleToIr, type D360Export } from './adapters/document360.js';
import { readMintlifyRepo, mintlifySnippetResolver } from './adapters/mintlify.js';
import { readGitbookRepo } from './adapters/gitbook.js';
import { readReadmeRepo, ReadmeApi, readmeApiTree } from './adapters/readme.js';
import { scanComponentDefinitions, attachDefinitions } from './adapters/definitions.js';
import { writeTree, readTree, buildDocumentationNavigation, pagesWithoutPlacement, placedPageIds, type GroupOpenapiRef, type SourceNavigationNode, type Tree, type TreePage } from './nav/tree.js';
import { documentationSiteSettings, withoutSourceBranding } from './nav/site-settings.js';
import { defaultUrlPlan, writeUrlPlan, readUrlPlan, applyUrlPlan, redirectMaps, anchorMap, type RedirectRule } from './urls/plan.js';
import { retargetDocLinks, siteLinkResolver, siteLinkTarget, siteLinksFor, type SiteLinks } from './urls/site-links.js';
import { RulesEngine, loadMappings, collectComponents, type ComponentPlanEntry } from './components/rules-engine.js';
import { clusterComponents, type ClusterEntry } from './components/signature.js';
import { Ledger } from './ledger/dispositions.js';
import { DecisionLog } from './log/decisions.js';
import { redact } from './log/redact.js';
import { docToMdx } from './ir/to-dai-mdx.js';
import type { DocIR } from './ir/types.js';
import { walkBlocks, inlineText } from './ir/types.js';
import { applyBlockExclusions, assertExclusionsPermitted, blockExclusionsPath, readBlockExclusions, unmatchedBlockExclusions } from './ir/exclusions.js';
import { describeUnreadableDimension, unreadableImageDimensions } from './ir/dimensions.js';
import { readManifest, referenceTally, rewriteAssetRefs, d360MediaResolver } from './assets/manifest.js';
import { s3StorageFromEnv, s3StorageProblems, type AssetProviderOptions } from './assets/providers.js';
import { assertAssetsHosted, runAssetsStage, UnhostedAssetsError, type AssetsStageResult } from './assets/stage.js';
import { runGates, canonicalHash, previewPushBlockers, waivedExactnessGates, type GateResult, type SourceEvidence } from './verify/gates.js';
import { loadRawSourcePages, rawSourceIr, type RawSourcePage } from './verify/source-truth.js';
import { runBrowserContentGate, runBrowserFragmentGate, type BrowserAnchor, type ExpectedNavigationEntry } from './verify/browser.js';
import { authoredContentSnapshot, fidelityEqual, firstFidelityDifference, renderedDocSnapshot } from './verify/fidelity.js';
import { unconvertedFidelityRecord, writeFidelityRecords, type FidelityRecord } from './verify/fidelity-records.js';
import { writeMigrationBranch } from './write/migration-branch.js';
import { writeGates, writeReviewQueue, writeSummary, writePlatformGaps, readDecisions, writeConnectionSummary, type RunProvenance } from './report/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(here, '..', '..', '..');
const CORE_VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version as string;

const HELP = `dai-migrate <command> [options]

Commands (run in order; the workflow has exactly four standard human gates):
  init         --workspace <dir> --source <url|path> --target customer-org|demo-org --remote <git url> [--platform p] [--export <zip|dir>] [--fidelity exact|permissive] [--allowed-orgs a,b] [--customer-authorised]
               verifies the remote, the API key, the connected repository, previews and the media API up front; records the asset provider
  fingerprint  [--url <u>] [--export <zip|dir>] [--repo <dir>]     → plan/fingerprint.json
  discover     [--export <zip|dir>] [--url <u>] [--discovery-limit n] → plan/tree.yaml [gate 1: scope]
  acquire      [--fetcher local|firecrawl] [--zero-data-retention] [--profile p] [--urls file] [--proxy url] [--headers-file json] [--cookies-file file] → source-cache/acquired/
  inventory                                                         → snapshot/, inventory/*.json
  plan         [--mode preserve|restructure|hybrid] [--strip-prefix p] [--case preserve|lower] → plan/*.yaml [gate 2: conversion plan]
  assets       [--provider none|local|s3|dai-api]                   → plan/assets.json, assets-original/
  convert                                                           → output/, ledger/, quarantine/
  nav                                                               → output/documentation.json, report/redirects.*.json, report/anchors.json
  write        [--repo <dir>] [--remote <url>] [--push] [--allow-lossy] [--no-wait] [--preview-timeout min] → refs/heads/migration/<session>; with --push waits for the preview deployment and records its URL
               --allow-lossy (permissive sessions only) pushes an exploratory branch with unproven exactness gates waived; failed gates still block
  verify       [--preview] [--preview-url <u>] [--preview-contract-version v] → local [gate 3: pre-push] or preview [gate 4: release]; --preview uses the URL recorded by write
  report                                                            → report/summary.md, report/platform-gaps.json

Every command except init takes --workspace <dir> (or MIGRATION_WORKSPACE).`;

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string', default: process.env.MIGRATION_WORKSPACE },
    source: { type: 'string' }, target: { type: 'string' }, platform: { type: 'string' }, export: { type: 'string' }, url: { type: 'string' }, repo: { type: 'string' },
    'allowed-orgs': { type: 'string', default: process.env.MIGRATION_ALLOWED_ORGS ?? '' },
    'customer-authorised': { type: 'boolean', default: false },
    fidelity: { type: 'string', default: 'exact' },
    mode: { type: 'string' }, 'strip-prefix': { type: 'string' }, case: { type: 'string' },
    provider: { type: 'string', default: process.env.MIGRATION_ASSET_PROVIDER }, fetcher: { type: 'string', default: 'local' }, profile: { type: 'string' }, urls: { type: 'string' },
    'discovery-limit': { type: 'string', default: process.env.MIGRATION_DISCOVERY_LIMIT ?? '5000' },
    'firecrawl-proxy': { type: 'string', default: process.env.FIRECRAWL_PROXY_MODE ?? 'auto' },
    'max-concurrency': { type: 'string', default: process.env.FIRECRAWL_MAX_CONCURRENCY },
    'firecrawl-timeout-min': { type: 'string', default: process.env.FIRECRAWL_TIMEOUT_MIN ?? '360' },
    openapi: { type: 'string', multiple: true },
    concurrency: { type: 'string', default: process.env.MIGRATION_CONCURRENCY ?? '4' },
    rps: { type: 'string', default: process.env.MIGRATION_RPS ?? '2' },
    refresh: { type: 'boolean', default: false },
    'zero-data-retention': { type: 'boolean', default: process.env.FIRECRAWL_ZERO_DATA_RETENTION === '1' },
    proxy: { type: 'string', default: process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY },
    'headers-file': { type: 'string', default: process.env.MIGRATION_HEADERS_FILE }, 'cookies-file': { type: 'string', default: process.env.MIGRATION_COOKIES_FILE }, 'auth-origin': { type: 'string', default: process.env.MIGRATION_AUTH_ORIGINS },
    remote: { type: 'string' }, push: { type: 'boolean', default: false }, 'allow-lossy': { type: 'boolean', default: false },
    'no-wait': { type: 'boolean', default: false }, 'preview-timeout': { type: 'string', default: process.env.MIGRATION_PREVIEW_TIMEOUT_MIN ?? '15' },
    preview: { type: 'boolean', default: false }, 'preview-url': { type: 'string' }, 'preview-contract-version': { type: 'string' },
    'log-originals': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

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
}
function readJson<T>(p: string): T { return JSON.parse(readFileSync(p, 'utf8')) as T; }
function writeJson(p: string, o: unknown) { mkdirSync(dirname(p), { recursive: true, mode: 0o700 }); writeFileSync(p, JSON.stringify(o, null, 2) + '\n', { mode: 0o600 }); }
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
function requireStages(session: Session, ...stages: string[]): void {
  const missing = stages.filter((stage) => session.stages[stage]?.status !== 'done');
  if (missing.length) fail(`required stage(s) not complete: ${missing.join(', ')}`);
}
function requireFrozenInputs(workspace: string, session: Session): SourceManifest {
  const manifest = requireSourceManifest(workspace, session.hashes.sourceManifest);
  requireAcquisition(workspace, manifest, session.hashes.acquisition, readTree(workspace).pages);
  return manifest;
}
function resetDir(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true, mode: 0o700 });
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

function loadSnapshot(workspace: string): DocIR[] {
  const dir = join(workspace, 'snapshot', 'pages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson<DocIR>(join(dir, f)));
}

function mappingPaths(platform: string): string[] {
  const out: string[] = [];
  const own = join(PLUGIN_ROOT, 'skills', `migrate-${platform}`, 'mappings', `${platform}.yaml`);
  if (existsSync(own)) out.push(own);
  out.push(join(PLUGIN_ROOT, 'skills', 'migrate-generic', 'mappings', 'generic.yaml'));
  return out;
}

const SKIP_REPO_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache']);
function sourceFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_REPO_DIRS.has(entry.name)) sourceFiles(root, p, out); }
    else if (/\.(?:md|mdx|html?)$/i.test(entry.name)) out.push(p);
  }
  return out.sort();
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

function canonicalHostsPath(workspace: string): string { return join(workspace, 'inventory', 'canonical-hosts.json'); }
/** The seed site's paired hosts from the profile plus the hosts discovery recorded from robots.txt and llms.txt. */
function sourceCanonicalHosts(workspace: string, seedUrl: string, profile: ScrapeProfile): CanonicalHosts {
  const recorded = existsSync(canonicalHostsPath(workspace)) ? readJson<{ aliases: string[] }>(canonicalHostsPath(workspace)).aliases : [];
  return new CanonicalHosts(new URL(seedUrl).origin, [...profileHostAliases(profile, new URL(seedUrl).hostname), ...recorded]);
}

/** How links resolve in this workspace's migrated site: the tree's routes, every path the frozen source is known to publish, the source's host aliases and the URL plan's choice for unmigrated links. */
function siteLinksForWorkspace(workspace: string, tree: Tree): SiteLinks {
  const manifest = existsSync(sourceManifestPath(workspace)) ? readJson<SourceManifest>(sourceManifestPath(workspace)) : undefined;
  const llmsPath = join(workspace, 'inventory', 'llms.json');
  const llms = existsSync(llmsPath) ? readJson<{ entries?: Array<{ path: string }> } | null>(llmsPath) : null;
  const hosts = existsSync(canonicalHostsPath(workspace)) ? readJson<{ aliases?: string[] }>(canonicalHostsPath(workspace)).aliases ?? [] : [];
  const sourcePages = [...(manifest?.pages ?? []).map((page) => page.location), ...(llms?.entries ?? []).map((entry) => entry.path)];
  return siteLinksFor(tree, { unmigrated: readUrlPlan(workspace)?.unmigratedLinks ?? 'keep', sourcePages, hosts });
}

function readComponentPlan(workspace: string): Record<string, ComponentPlanEntry> {
  const p = join(workspace, 'plan', 'component-plan.yaml');
  if (!existsSync(p)) return {};
  const y = parseYaml(readFileSync(p, 'utf8')) as { components: Array<ComponentPlanEntry & { signature?: { hash?: string } }> };
  const out: Record<string, ComponentPlanEntry> = {};
  // the engine looks entries up by the full signature hash recorded in the plan
  for (const c of y.components ?? []) if (c.signature?.hash) out[c.signature.hash] = c;
  return out;
}

/** inventory/platform-meta.json: site metadata and connections the source adapter recorded at discovery. */
interface PlatformMeta {
  name?: string;
  theme?: string;
  colors?: Record<string, string>;
  logo?: unknown;
  favicon?: string;
  redirects?: { exact: RedirectRule[]; wildcard: RedirectRule[] };
  openapi?: GroupOpenapiRef[];
  /** Source repository root the openapi specs are relative to. */
  root?: string;
  openapiCaptured?: boolean;
}

/** Captures full spec graphs before conversion; private catalogs need an explicitly supplied export. */
async function captureOpenapi(workspace: string, session: Session, tree: Tree): Promise<string | undefined> {
  const path = join(workspace, 'inventory', 'openapi.json');
  if (session.hashes.openapi) {
    if (!existsSync(path) || fileHash(path) !== session.hashes.openapi) fail('OpenAPI manifest changed after acquisition');
    return session.hashes.openapi;
  }
  const meta = readPlatformMeta(workspace);
  const supplied = (v.openapi ?? []).map((source) => /^https?:\/\//i.test(source) ? source : pathToFileURL(resolve(source)).toString());
  const frozenRoot = frozenRootPath(workspace);
  // Mintlify writes repository paths as "/api-reference/openapi.json"; they are relative to the repository, never the filesystem root
  const native = (meta.openapi ?? []).map((entry) => {
    if (/^https?:\/\//i.test(entry.spec)) return entry.spec;
    const file = resolve(frozenRoot, entry.spec.replace(/^\/+/, ''));
    if (!file.startsWith(frozenRoot + '/')) fail(`openapi spec ${entry.spec} for group ${entry.groupPath.join(' / ')} points outside the source repository`);
    return pathToFileURL(file).toString();
  });
  const fetcher = new Fetcher(networkOptions(workspace, session));
  let catalog: string[] = [];
  if (tree.platform === 'readme' && session.source.kind === 'url' && !supplied.length) {
    const catalogUrl = new URL('/.well-known/api-catalog', session.source.location).toString();
    const response = await fetcher.get(catalogUrl);
    if (response.status === 200) {
      writeFileSync(join(workspace, 'source-cache', 'readme-api-catalog.json'), response.body, { mode: 0o600 });
      catalog = readmeCatalogSpecs(response.body, catalogUrl);
    } else if (![404, 401, 403].includes(response.status)) fail(`ReadMe API catalog returned HTTP ${response.status}`);
    writeJson(join(workspace, 'inventory', 'readme-api-catalog.json'), { url: catalogUrl, status: response.status, specs: catalog, ...(catalog.length ? {} : { issue: 'No public specs available; supply authorized exports with acquire --openapi <file-or-url>. API-reference completeness remains unproven.' }) });
  }
  const roots = [...new Set([...native, ...supplied, ...catalog])];
  if (!roots.length) return undefined;
  // native specs may reference anything in the frozen repository; a supplied spec only its own directory
  const localRoots = supplied.filter((url) => url.startsWith('file:')).map((url) => dirname(fileURLToPath(url)));
  if (native.some((url) => url.startsWith('file:'))) localRoots.push(frozenRoot);
  const manifest = await captureSpecGraph({ workspace, roots, concurrency: Number(v.concurrency), fetch: async (url) => {
    if (url.startsWith('file:')) {
      const file = resolve(fileURLToPath(url));
      if (!localRoots.some((root) => file.startsWith(root + '/')) || !/\.(?:json|ya?ml)$/i.test(file)) throw new Error(`OpenAPI file reference is outside supplied spec directories or has an unsupported extension: ${file}`);
      return { body: readFileSync(file, 'utf8'), status: 200, finalUrl: url };
    }
    if (!/^https?:\/\//i.test(url)) throw new Error(`unsupported OpenAPI source protocol: ${url}`);
    return fetcher.get(url);
  } });
  writeJson(path, manifest);
  if (meta.openapi?.length) {
    const rewritten = meta.openapi.map((entry, i) => {
      const url = new URL(native[i]); url.hash = '';
      return { ...entry, spec: `openapi/${manifest.documents.find((document) => document.source === url.toString())!.file}` };
    });
    writeJson(join(workspace, 'inventory', 'platform-meta.json'), { ...meta, openapi: rewritten, openapiCaptured: true });
  }
  ok(`${manifest.documents.length} OpenAPI documents captured without flattening; ${manifest.operations.length} operations indexed`);
  return fileHash(path);
}

function readPlatformMeta(workspace: string): PlatformMeta {
  const p = join(workspace, 'inventory', 'platform-meta.json');
  return existsSync(p) ? readJson<PlatformMeta>(p) : {};
}

/**
 * The acquisition, re-read for verification: the frozen pages, the profile that
 * describes the rendered source, and the navigation extracted afresh from the
 * frozen HTML so the written navigation is judged against the source rather than
 * against the tree this run built from it.
 */
function buildSourceEvidence(workspace: string, tree: Tree): SourceEvidence | undefined {
  const profile = getProfile(tree.platform);
  let pages: RawSourcePage[];
  try { pages = loadRawSourcePages({ workspace, outputDir: join(workspace, 'output'), pages: tree.pages }); }
  catch (error) { fail((error as Error).message); }
  if (!pages.length) return undefined;

  const seed = tree.pages.find((page) => page.migrate && /^https?:\/\//.test(page.source))?.source;
  const home = pages.find((page) => page.path === '/') ?? pages[0];
  let navigation: Record<string, unknown> | undefined;
  let navigationSource: string | undefined;
  if (seed && home.html) {
    const origin = new URL(seed).origin;
    const extracted = tree.platform === 'mintlify' ? extractMintlifyNavigation(home.html, origin)?.navigation : undefined;
    const fromDom = extracted ? undefined : reExtractDomNavigation(pages, tree, home, seed, origin, profile);
    const nodes = extracted ?? fromDom;
    if (nodes) {
      navigationSource = extracted ? 'platform-metadata' : 'dom-sidebar';
      const byUrl = new Map(tree.pages.map((page) => [page.source.replace(/\/$/, ''), page.id]));
      const toSource = (items: DiscoveredNavigationNode[]): SourceNavigationNode[] => items.flatMap((node): SourceNavigationNode[] => {
        if (node.type === 'page') { const id = byUrl.get(node.url.replace(/\/$/, '')); return id ? [{ type: 'page', pageId: id, title: node.title }] : []; }
        const children = toSource(node.children);
        return children.length || node.href ? [{ ...node, children }] : [];
      });
      navigation = buildDocumentationNavigation({ ...tree, navigation: toSource(nodes) }, writtenPagePaths(workspace, tree), readPlatformMeta(workspace)).navigation;
    }
  }
  return { pages, platform: tree.platform, profile, navigation, navigationSource, indexedRoutes: pages.map((page) => page.route), links: siteLinksForWorkspace(workspace, tree) };
}

/**
 * The rendered navigation, re-read from the frozen pages. A site divided into sections
 * renders one sidebar per section, so each section's sidebar comes from a page inside it;
 * discovery assembled the tabs the same way, from the same HTML.
 */
function reExtractDomNavigation(pages: RawSourcePage[], tree: Tree, home: RawSourcePage, seed: string, origin: string, profile: ScrapeProfile): DiscoveredNavigationNode[] | undefined {
  const sections = home.html ? extractSectionTabs(home.html, seed, origin, profile) : undefined;
  if (sections) {
    const sourceById = new Map(tree.pages.map((page) => [page.id, page.source]));
    const sidebars = new Map<string, DiscoveredNavigationNode[]>();
    for (const page of pages) {
      const url = sourceById.get(page.pageId);
      if (!url || !page.html || !/^https?:\/\//.test(url)) continue;
      const section = sectionOfUrl(url, sections);
      if (!section || sidebars.has(section.url)) continue;
      const dom = extractDomSidebarNavigation(page.html, url, origin, profile);
      if (dom) sidebars.set(section.url, dom);
      if (sidebars.size === sections.length) break;
    }
    const navigation = siteSectionNavigation(sections, sidebars);
    if (navigation) return navigation;
  }
  return home.html ? extractDomSidebarNavigation(home.html, seed, origin, profile) : undefined;
}

/** The Documentation.AI renderer's sidebar container, used to check the deployed navigation. */
const DAI_PREVIEW_NAV_SELECTOR = 'nav, aside, [role=navigation]';
/** The rendered page's own content on a Documentation.AI preview: title, description and MDX body, without the breadcrumbs, feedback, prev/next and footer the theme puts around them. */
const DAI_PREVIEW_CONTENT_SELECTORS = ['.page-title', '.page-description', '.mdx-container'];

/**
 * The sidebar the source states, flattened in reading order. A page placed in two groups
 * appears twice, which is what the rendered sidebar must show.
 */
function expectedSidebar(tree: Tree): ExpectedNavigationEntry[] {
  const byId = new Map(tree.pages.map((page) => [page.id, page]));
  const out: ExpectedNavigationEntry[] = [];
  const walk = (nodes: SourceNavigationNode[], groupPath: string[]): void => {
    for (const node of nodes) {
      if (node.type === 'group') { walk(node.children, [...groupPath, node.label]); continue; }
      const page = byId.get(node.pageId);
      if (page?.migrate && page.newPath) out.push({ groupPath, label: node.title ?? page.sidebarTitle ?? page.title });
    }
  };
  walk(tree.navigation ?? [], []);
  return out;
}

/** New paths (without extension) of the pages whose converted file exists in output/. */
function writtenPagePaths(workspace: string, tree: Tree): Set<string> {
  return new Set(tree.pages.flatMap((page) => (page.newPath && existsSync(join(workspace, 'output', `${page.newPath}.mdx`)) ? [page.newPath] : [])));
}

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
      if (existsSync(sourceManifestPath(workspace))) fail('source evidence is already frozen; review the existing tree or use a new workspace for a new discovery');
      const platform = s.source.platform ?? v.platform;
      let tree: Tree;
      let sourceManifest: SourceManifest | undefined;
      let frozen: FreezeResult | undefined;
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
          if ((platform === 'mintlify' || !platform) && (existsSync(join(root, 'docs.json')) || existsSync(join(root, 'mint.json')))) {
            sourceManifest = nativeSourceManifest({ ...captureContext, platform: 'mintlify', kind: 'repo', root, freeze: frozen });
            const r = readMintlifyRepo(root);
            tree = r.tree;
            Object.assign(meta, { platform: 'mintlify', configFile: r.configFile, name: r.name, colors: r.colors, logo: r.logo, favicon: r.favicon, redirects: r.redirects, openapi: r.openapi, missing: r.missing });
            ok(`${tree.pages.length} pages from ${r.configFile} (${[...new Set(tree.pages.map((p) => p.version).filter(Boolean))].length || 1} version(s)); ${r.missing.length} listed pages missing; ${r.redirects.exact.length} exact + ${r.redirects.wildcard.length} wildcard redirects; ${r.openapi.length} openapi group(s)`);
          } else if ((platform === 'gitbook' || !platform) && existsSync(join(root, 'SUMMARY.md')) || existsSync(join(root, '.gitbook.yaml'))) {
            sourceManifest = nativeSourceManifest({ ...captureContext, platform: 'gitbook', kind: 'repo', root, freeze: frozen });
            const r = readGitbookRepo(root);
            tree = r.tree;
            Object.assign(meta, { platform: 'gitbook', redirects: { exact: r.redirects, wildcard: [] }, missing: r.missing, unlisted: r.unlisted });
            ok(`${tree.pages.length} pages from SUMMARY.md; ${r.missing.length} missing, ${r.unlisted.length} unlisted files (review plan/tree.yaml)`);
          } else if (platform === 'readme' || (!platform && existsSync(join(root, 'docs')) && sourceFiles(join(root, 'docs')).some((f) => /^---[\s\S]*?^(slug|excerpt):/m.test(readFileSync(f, 'utf8'))))) {
            sourceManifest = nativeSourceManifest({ ...captureContext, platform: 'readme', kind: 'repo', root, freeze: frozen });
            const r = readReadmeRepo(root);
            tree = r.tree;
            Object.assign(meta, { platform: 'readme', hidden: r.hidden });
            ok(`${tree.pages.length} pages from the ReadMe sync repository; ${r.hidden.length} hidden pages skipped`);
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
          const discovery = await discoverLiveSite({ seedUrl: url, fetcher: f, profile, limit, concurrency: Number(v.concurrency), map: fc ? (u, n) => fc!.map(u, { limit: n }) : undefined });
          sourceManifest = liveSourceManifest({ ...captureContext, location: url }, discovery);
          writeFileSync(join(workspace, 'source-cache', 'discovery-result.json'), JSON.stringify(discovery), { mode: 0o600 });
          writeJson(join(workspace, 'inventory', 'discovery-failures.json'), discovery.failures);
          writeJson(join(workspace, 'inventory', 'sitemaps.json'), discovery.sitemaps);
          writeJson(join(workspace, 'inventory', 'llms.json'), discovery.llms ?? null);
          writeJson(canonicalHostsPath(workspace), { seed: canonicalHosts.seedOrigin, aliases: discovery.canonicalHosts });
          const orderTier = { sidebar: 0, sitemap: 1, crawl: 2 } as const;
          const pages: TreePage[] = discovery.pages.sort((a, b) => orderTier[a.orderSource] - orderTier[b.orderSource] || a.orderHint - b.orderHint || a.url.localeCompare(b.url)).map(({ url: u, reasons, title, description, sidebarTitle, domSidebarTitle, llms, groupHint, locale, version, sitemap }, i) => {
            const parsed = new URL(u);
            const parts = parsed.pathname.split('/').filter(Boolean);
            let pathGroups = parts.slice(0, -1);
            if (locale && pathGroups[0]?.toLowerCase() === locale.toLowerCase()) pathGroups = pathGroups.slice(1);
            const groups = pathGroups.length ? pathGroups.map((x) => decodeURIComponent(x).replace(/[-_]+/g, ' ')) : (groupHint ?? []);
            // A URL-derived title is a placeholder, marked as such: inventory replaces it with the page's own H1 and exact mode refuses one that survives.
            const titleSource: TreePage['titleSource'] = llms?.title ? 'llms-txt' : title ? 'platform-metadata' : 'path';
            return {
              id: pageIdFromPlatform(platform ?? 'generic', u), title: llms?.title ?? title ?? decodeURIComponent(parts.at(-1) ?? 'index').replace(/[-_]+/g, ' '), titleSource, sidebarTitle, domSidebarTitle, description, llms, source: u,
              group: groups, order: i, oldPath: parsed.pathname, migrate: true, locale, version, reason: reasons.join('+'),
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
            if (children.length || node.href) out.push({ ...node, children });
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
          ok(`${pages.length} unique URLs from ${discovery.llms ? `${discovery.llms.entries.length} llms.txt entries, ` : ''}recursive links, sidebars, ${discovery.sitemaps.sources.length} sitemap file(s) and configured map sources${discovery.canonicalHosts.length ? ` (canonical hosts: ${discovery.canonicalHosts.join(', ')})` : ''}; ${discovery.failures.length} fetch failures${discovery.truncated ? '; limit reached' : ''}`);
        }
      }
      if (frozen && !sourceManifest) sourceManifest = nativeSourceManifest({ ...captureContext, platform: tree.platform, kind: s.source.kind === 'export' ? 'export' : 'repo', root: frozenRootPath(workspace), freeze: frozen });
      if (!sourceManifest) fail('discovery produced no independent source manifest');
      const manifestHash = writeSourceManifest(workspace, sourceManifest);
      const discoveredSession = readSession(workspace);
      discoveredSession.hashes.sourceManifest = manifestHash;
      if (sourceManifest.source.kind === 'api') discoveredSession.hashes.acquisition = pinAcquisition(workspace, sourceManifest, tree.pages.filter((page) => page.migrate), false);
      writeSession(workspace, discoveredSession);
      ensureScopeDecisionsFile(workspace);
      writeTree(workspace, tree);
      if (sourceManifest.issues?.length && (s.fidelityMode ?? 'exact') === 'exact') {
        markStage(workspace, 'discover', 'failed', 'source universe unproven');
        fail(`source discovery cannot be certified: ${sourceManifest.issues.slice(0, 8).join('; ')}. See ${sourceManifestPath(workspace)}; fix the source or adapter and discover in a new workspace`);
      }
      markStage(workspace, 'discover', 'done');
      humanGate(1, 'scope and structure', `review ${join(workspace, 'plan', 'tree.yaml')} plus source-specific inventory; confirm pages, groups, order, versions and locales before acquisition/inventory`);
      break;
    }
    case 'acquire': {
      const workspace = ws(); const s = readSession(workspace); const tree = readTree(workspace);
      requireStages(s, 'discover');
      const sourceManifest = requireSourceManifest(workspace, s.hashes.sourceManifest);
      if (s.source.kind === 'repo' || s.source.kind === 'export') { s.hashes.openapi = await captureOpenapi(workspace, s, tree); writeSession(workspace, s); markStage(workspace, 'acquire', 'done', 'native source and OpenAPI graph frozen'); ok('native source and OpenAPI graph acquired'); break; }
      if (s.hashes.acquisition) {
        if (v.refresh) fail('acquisition is pinned; use a new workspace for refreshed source bytes');
        requireAcquisition(workspace, sourceManifest, s.hashes.acquisition, tree.pages);
        ok('completed acquisition matches its session pin; no requests needed'); break;
      }
      const profile = getProfile(v.profile ?? tree.platform);
      s.hashes.openapi = await captureOpenapi(workspace, s, tree);
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
        await acquireFirecrawlPages({ workspace, pages, profile, fidelityMode: s.fidelityMode ?? 'exact', concurrency: Number(v.concurrency), resume: !v.refresh, fetcher: publishedFetcher, responses: got, loadResponse: (url) => readFirecrawlPage(workspace, url) });
      } else {
        const host = new URL(s.source.location).hostname;
        const fetcher = new Fetcher({ ...networkOptions(workspace, s, [host]), canonicalHosts: sourceCanonicalHosts(workspace, s.source.location, profile) });
        const acquisition = await acquirePages({ workspace, pages, fetcher, profile, fidelityMode: s.fidelityMode ?? 'exact', concurrency: Number(v.concurrency), resume: !v.refresh });
        for (const fallback of acquisition.markdownUnavailable) console.log(`· ${fallback.url}: published Markdown not acquired (${fallback.reason}); permissive mode keeps the rendered HTML`);
      }
      s.hashes.acquisition = pinAcquisition(workspace, sourceManifest, pages, (s.fidelityMode ?? 'exact') === 'exact' && !!profile.mdSuffix);
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
          if (/\.mdx?$/i.test(file)) docs.push(attachDefinitions(markdownToIr(raw, { platform: tree.platform, file: p.source, pageId: p.id, title: p.title, resolveSnippet: tree.platform === 'mintlify' ? mintlifySnippetResolver(root) : undefined, codeMetaStrip: profile.codeMetaStrip }), definitions));
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
            docs.push(markdownToIr(published.body, { platform: tree.platform, file: p.source, pageId: p.id, title, frontmatter: { title, ...(description ? { description } : {}) }, codeMetaStrip: profile.codeMetaStrip }));
          }
          else {
            if (page.html === undefined) fail(`acquired record for ${p.source} holds neither published Markdown nor HTML; run dai-migrate acquire again`);
            const ir = htmlToIr(page.html, htmlAdapterOptions(profile, { platform: tree.platform, file: p.source }));
            // No published Markdown here, so the page's own H1 is the H1 of the rendered article.
            const firstHeading = ir.children.find((block) => block.type === 'heading' && block.depth === 1);
            const h1 = firstHeading?.type === 'heading' ? inlineText(firstHeading.children).trim() || undefined : undefined;
            // The site's own statements only: its llms.txt entry, then the rendered article's H1, then platform metadata.
            // A URL-derived placeholder is never a title, so exact mode stops rather than inventing one.
            const stated = p.llms?.title ?? h1 ?? (p.titleSource && p.titleSource !== 'path' ? p.title : undefined);
            if (!stated && (s.fidelityMode ?? 'exact') === 'exact') fail(`no source title for ${p.source}: its llms.txt entry, rendered <h1> and platform metadata all lack one (titleSource ${p.titleSource ?? 'unset'}); re-run init with --fidelity permissive to fall back to the URL`);
            const title = stated ?? p.title;
            const description = page.llms?.description ?? page.description ?? p.description;
            docs.push({ pageId: p.id, platform: tree.platform, source: p.source, frontmatter: { title, ...(description ? { description } : {}) }, children: ir.children });
          }
        }
      }
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
      const anchors: Array<{ pageId: string; headings: Array<{ id: string; text: string; sourceId?: string }> }> = [];
      const links: Array<{ pageId: string; url: string }> = [];
      const snapDir = join(workspace, 'snapshot', 'pages'); resetDir(snapDir);
      for (const doc of docs) {
        writeJson(join(snapDir, `${doc.pageId}.json`), doc);
        const heads: Array<{ id: string; text: string; sourceId?: string }> = [];
        walkBlocks(doc.children, (n, depth) => {
          if (n.type === 'component') comps.push({ pageId: doc.pageId, node: n, depth, source: doc.source });
          if (n.type === 'heading') heads.push({ id: n.id, text: inlineText(n.children), sourceId: n.sourceId });
          if (n.type === 'paragraph') for (const i of n.children) if (i.type === 'link') links.push({ pageId: doc.pageId, url: i.url });
        });
        anchors.push({ pageId: doc.pageId, headings: heads });
      }
      const clusters = clusterComponents(comps);
      writeJson(join(workspace, 'inventory', 'components.json'), clusters);
      writeJson(join(workspace, 'inventory', 'anchors.json'), anchors);
      writeJson(join(workspace, 'inventory', 'links.json'), links);
      const snapHash = sha256(readdirSync(snapDir).sort().map((f) => fileHash(join(snapDir, f))).join('\n'));
      s.hashes.snapshot = snapHash; writeSession(workspace, s);
      markStage(workspace, 'inventory', 'done');
      ok(`${docs.length} pages snapshotted, ${clusters.length} component clusters, ${links.length} links; snapshot ${snapHash.slice(0, 12)}`);
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
        const prev = byCluster.get(c.cluster);
        if (prev) return prev;
        const rule = engine.findRule({ id: 'x', type: 'component', name: c.signature.name, platform: c.signature.platform, props: Object.fromEntries(Object.entries(c.signature.props).map(([k, b]) => [k, b.startsWith('enum:') ? b.slice(5) : b === 'null' ? null : 'x'])), children: [], styleDeps: c.signature.styleDeps });
        const hasExpression = c.signature.styleDeps.some((x) => x.startsWith('expression:'));
        const entry: ComponentPlanEntry & { count: number; signature: unknown } = {
          cluster: c.cluster, count: c.count, signature: c.signature,
          tier: hasExpression ? 'T7' : rule?.tier ?? 'T7', rule: rule?.id,
          status: rule && !hasExpression ? 'auto' : 'needs-review',
          reason: hasExpression ? 'non-literal MDX expression; never evaluated automatically' : rule ? undefined : 'no mapping rule; T7 preserve as sanitised fragment unless excluded or a rule is added',
        };
        return entry;
      });
      writeFileSync(planPath, toYaml({ components }), { mode: 0o600 });
      const urlPlan = readUrlPlan(workspace) ?? defaultUrlPlan(tree, { mode: (v.mode as any) ?? 'preserve', stripPrefix: v['strip-prefix'], case: (v.case as any) ?? 'preserve' });
      writeUrlPlan(workspace, urlPlan);
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
      const blockExclusions = readBlockExclusions(workspace);
      // exact mode carries every authored block; an operator exclusion is refused before anything is read or written
      if ((s.fidelityMode ?? 'exact') === 'exact' && blockExclusions.length) fail(`block exclusions are not permitted in exact mode: plan/block-exclusions.yaml lists ${blockExclusions.length} (${blockExclusions.map((e) => `${e.pageId}:${e.nodeId}`).join(', ')}); remove them, or re-run init with --fidelity permissive`);
      requireFrozenInputs(workspace, s);
      const tree = applyUrlPlan(readTree(workspace), readUrlPlan(workspace) ?? defaultUrlPlan(readTree(workspace)));
      const docs = loadSnapshot(workspace);
      const manifest = readManifest(workspace);
      const unmatchedExclusions = unmatchedBlockExclusions(docs, blockExclusions);
      if (unmatchedExclusions.length) fail(`plan/block-exclusions.yaml names nodes that are not in the snapshot: ${unmatchedExclusions.map((e) => `${e.pageId}:${e.nodeId}`).join(', ')}`);
      const plan = readComponentPlan(workspace);
      const assetsPlan = existsSync(join(workspace, 'plan', 'assets.yaml')) ? (parseYaml(readFileSync(join(workspace, 'plan', 'assets.yaml'), 'utf8')) as { iframeHosts?: string[] }) : {};
      // fresh ledger and log per convert run
      for (const f of ['ledger/dispositions.jsonl', 'logging/decisions.jsonl']) { const p = join(workspace, f); if (existsSync(p)) writeFileSync(p, ''); }
      const ledger = new Ledger(workspace); const log = new DecisionLog(workspace, !!v['log-originals']);
      const engine = new RulesEngine({ platform: tree.platform, mappings: loadMappings(mappingPaths(tree.platform)), plan, ledger, log, iframeHosts: assetsPlan.iframeHosts });
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
      const anchors = existsSync(join(workspace, 'inventory', 'anchors.json')) ? readJson<Array<{ pageId: string; headings: Array<{ id: string; text: string; sourceId?: string }> }>>(join(workspace, 'inventory', 'anchors.json')) : [];
      const links = existsSync(join(workspace, 'inventory', 'links.json')) ? readJson<Array<{ pageId: string; url: string }>>(join(workspace, 'inventory', 'links.json')) : [];
      const inbound = new Map<string, number>();
      for (const l of links) { const h = l.url.split('#')[1]; if (h) inbound.set(`#${h}`, (inbound.get(`#${h}`) ?? 0) + 1); }
      const shims = anchorMap(anchors, inbound).shims;
      let converted = 0; let heldForSnippets = 0; let quarantinedForFidelity = 0;
      // every snapshot page gets a record, so verify can tell a page convert skipped on purpose from one it never saw
      const fidelityRecords: FidelityRecord[] = [];
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
        const sourcePrepared = retargetDocLinks(rewriteAssetRefs(inlineSnippetBodies(doc, snippets), manifest), siteLink);
        const withSnippets = inlineSnippetBodies(applyBlockExclusions(doc, blockExclusions, ledger), snippets);
        const recordSiteLink = (url: string, source?: string): string => {
          const outcome = resolveSiteLink(url, source);
          if (outcome && outcome.kind !== 'route') unmigratedLinks.push({ pageId: doc.pageId, route: page.newPath!, url, target: outcome.target, action: outcome.kind, knownSourcePage: outcome.knownSourcePage });
          return outcome?.target ?? url;
        };
        const resolved = engine.resolveDoc(retargetDocLinks(rewriteAssetRefs(withSnippets, manifest), recordSiteLink));
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
        const mdx = docToMdx(resolved, { anchorShims: shims.get(doc.pageId) });
        const outPath = join(outDir, `${page.newPath}.mdx`);
        mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
        writeFileSync(outPath, mdx, { mode: 0o600 });
        converted++;
      }
      writeFidelityRecords(workspace, fidelityRecords);
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
        const dst = join(workspace, 'output', ref.spec); mkdirSync(dirname(dst), { recursive: true, mode: 0o700 }); writeFileSync(dst, readFileSync(src), { mode: 0o600 });
      }
      // A page the source placed but the output does not would disappear from the sidebar without a word.
      const unplaced = pagesWithoutPlacement(tree).filter((page) => page.navMembership !== 'unlisted');
      if (unplaced.length && (s.fidelityMode ?? 'exact') === 'exact') {
        fail(`${unplaced.length} migrated page(s) have no placement in the source navigation and are not marked unlisted:\n${unplaced.map((page) => `  ${page.source} (${page.id})`).join('\n')}\nre-run discover so the navigation covers them, mark them unlisted in plan/tree.yaml, or re-run init with --fidelity permissive`);
      }
      const unlisted = pagesWithoutPlacement(tree).filter((page) => page.navMembership === 'unlisted');
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
      const anchors = existsSync(join(workspace, 'inventory', 'anchors.json')) ? readJson<Array<{ pageId: string; headings: Array<{ id: string; text: string; sourceId?: string }> }>>(join(workspace, 'inventory', 'anchors.json')) : [];
      const links = existsSync(join(workspace, 'inventory', 'links.json')) ? readJson<Array<{ pageId: string; url: string }>>(join(workspace, 'inventory', 'links.json')) : [];
      const inbound = new Map<string, number>();
      for (const l of links) { const h = l.url.split('#')[1]; if (h) inbound.set(`#${h}`, (inbound.get(`#${h}`) ?? 0) + 1); }
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
      const docs = loadSnapshot(workspace);
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
      const sourceEvidence = s.source.kind === 'url' ? buildSourceEvidence(workspace, tree) : undefined;
      const gates = runGates({
        workspace, outputDir: join(workspace, 'output'), sourceEvidence, pinnedSourceManifest: s.hashes.sourceManifest, pinnedAcquisition: s.hashes.acquisition, pinnedOpenapi: s.hashes.openapi,
        pinnedPlans: { componentPlan: s.hashes.componentPlan, urlPlan: s.hashes.urlPlan, assetPlan: s.hashes.assetPlan, blockExclusions: s.hashes.blockExclusions, scopeDecisions: s.hashes.scopeDecisions },
        sourceDocs: docs.map((doc) => ({ doc, outputFile: byId.get(doc.pageId)?.newPath ? join(workspace, 'output', `${byId.get(doc.pageId)!.newPath}.mdx`) : undefined })),
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
        const browser = await runBrowserFragmentGate(previewUrl, tree.pages, browserAnchors);
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
            const snapshot = docs.find((doc) => doc.pageId === page.id);
            return { ...page, doc: fromSource ?? (snapshot && retargetDocLinks(snapshot, previewSiteLink)) };
          }),
          {
            routes: writtenPagePaths(workspace, tree),
            assetUrls: new Map(Object.entries(manifest.byUrl).flatMap(([url, hash]) => { const final = manifest.entries[hash]?.finalUrl; return final ? [[url, final] as [string, string]] : []; })),
            navigation: expectedSidebar(tree),
            navSelector: DAI_PREVIEW_NAV_SELECTOR,
            contentSelectors: DAI_PREVIEW_CONTENT_SELECTORS,
            siteName: typeof readPlatformMeta(workspace).name === 'string' ? readPlatformMeta(workspace).name : undefined,
          },
        );
        const contentIndex = gates.findIndex((g) => g.id === 'browser-content');
        if (contentIndex >= 0) gates[contentIndex] = browserContent.gate; else gates.push(browserContent.gate);
        writeJson(join(workspace, 'report', 'preview-routes.json'), browserContent.routes);
      }
      writeGates(workspace, gates, canonicalHash(join(workspace, 'output')));
      const clusters = existsSync(join(workspace, 'inventory', 'components.json')) ? readJson<ClusterEntry[]>(join(workspace, 'inventory', 'components.json')) : [];
      writeReviewQueue(workspace, gates, clusters, Object.fromEntries(Object.entries(plan).map(([k, c]) => [k, c.status ?? 'auto'])));
      if (!s.hashes.canonicalOutput) { s.hashes.canonicalOutput = canonicalHash(join(workspace, 'output')); writeSession(workspace, s); }
      for (const g of gates) console.log(`  ${g.status === 'pass' ? '✔' : g.status === 'fail' ? '✖' : '·'} ${g.id}: ${g.detail}`);
      const blocked = gates.filter((g) => g.status !== 'pass').length;
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
      markStage(workspace, 'report', 'done');
      ok('report/summary.md and report/platform-gaps.json written');
      break;
    }
    default: fail(`unknown command ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => fail((e as Error).message));
