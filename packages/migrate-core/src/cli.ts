#!/usr/bin/env node
/**
 * dai-migrate: stage commands over an external workspace.
 *
 *   init → fingerprint → discover ⏸ → acquire → inventory → plan ⏸ → assets → convert → nav ⏸ → verify ×2 → push preview → verify preview ⏸ → report
 *
 * Every stage reads and writes files in the workspace; re-runs are safe.
 */
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { Cookie, CookieJar } from 'tough-cookie';
import { loadContract } from '@dai/content-contract';
import { assertOutsidePlugin, ensureWorkspace, readSession, writeSession, markStage, type Session, fileHash } from './session/workspace.js';
import { newMigrationId, pageIdFromPlatform, sha256 } from './session/ids.js';
import { preflight } from './session/preflight.js';
import { fingerprint } from './scrape/fingerprint.js';
import { Fetcher, sitemapUrls, type FetchOptions } from './scrape/fetcher.js';
import { Firecrawl } from './scrape/firecrawl.js';
import { getProfile } from './scrape/profiles.js';
import { htmlToIr, parseHtml, findAll } from './ir/from-html.js';
import { markdownToIr } from './ir/from-markdown.js';
import { extractIfZip, readD360Export, d360ArticleToIr, type D360Export } from './adapters/document360.js';
import { writeTree, readTree, buildNavigation, type Tree, type TreePage } from './nav/tree.js';
import { defaultUrlPlan, writeUrlPlan, readUrlPlan, applyUrlPlan, redirectMaps, anchorMap } from './urls/plan.js';
import { RulesEngine, loadMappings, collectComponents, type ComponentPlanEntry } from './components/rules-engine.js';
import { clusterComponents, type ClusterEntry } from './components/signature.js';
import { Ledger } from './ledger/dispositions.js';
import { DecisionLog } from './log/decisions.js';
import { docToMdx } from './ir/to-dai-mdx.js';
import type { DocIR } from './ir/types.js';
import { walkBlocks, inlineText } from './ir/types.js';
import { collectAssets, readManifest, rewriteAssetRefs, d360MediaResolver } from './assets/manifest.js';
import { runGates, canonicalHash, previewPushBlockers, type GateResult } from './verify/gates.js';
import { runBrowserFragmentGate, type BrowserAnchor } from './verify/browser.js';
import { writeMigrationBranch } from './write/migration-branch.js';
import { writeGates, writeReviewQueue, writeSummary, writePlatformGaps, readDecisions } from './report/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(here, '..', '..', '..');
const CORE_VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version as string;

const HELP = `dai-migrate <command> [options]

Commands (run in order; ⏸ = review the written plan file before continuing):
  init         --workspace <dir> --source <url|path> --target customer-org|demo-org [--platform p] [--export <zip|dir>] [--allowed-orgs a,b] [--customer-authorised]
  fingerprint  [--url <u>] [--export <zip|dir>] [--repo <dir>]     → plan/fingerprint.json
  discover     [--export <zip|dir>] [--url <u>]                     → plan/tree.yaml ⏸
  acquire      [--fetcher local|firecrawl] [--profile p] [--urls file] [--proxy url] [--headers-file json] [--cookies-file file] → source-cache/acquired/
  inventory                                                         → snapshot/, inventory/*.json
  plan         [--mode preserve|restructure|hybrid] [--strip-prefix p] [--case preserve|lower] → plan/*.yaml ⏸
  assets       [--provider none|local]                              → plan/assets.json, assets-original/
  convert                                                           → output/, ledger/, quarantine/
  nav                                                               → output/documentation.json, report/redirects.*.json, report/anchors.json ⏸
  write        --repo <dir> [--remote <url>] [--push]               → refs/heads/migration/<session>
  verify       [--preview-url <u>] [--preview-contract-version v]   → report/gates.json, report/review-queue.md ⏸
  report                                                            → report/summary.md, report/platform-gaps.json

Every command except init takes --workspace <dir> (or MIGRATION_WORKSPACE).`;

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string', default: process.env.MIGRATION_WORKSPACE },
    source: { type: 'string' }, target: { type: 'string' }, platform: { type: 'string' }, export: { type: 'string' }, url: { type: 'string' }, repo: { type: 'string' },
    'allowed-orgs': { type: 'string', default: process.env.MIGRATION_ALLOWED_ORGS ?? '' },
    'customer-authorised': { type: 'boolean', default: false },
    mode: { type: 'string' }, 'strip-prefix': { type: 'string' }, case: { type: 'string' },
    provider: { type: 'string', default: 'local' }, fetcher: { type: 'string', default: 'local' }, profile: { type: 'string' }, urls: { type: 'string' },
    proxy: { type: 'string', default: process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY },
    'headers-file': { type: 'string', default: process.env.MIGRATION_HEADERS_FILE }, 'cookies-file': { type: 'string', default: process.env.MIGRATION_COOKIES_FILE }, 'auth-origin': { type: 'string', default: process.env.MIGRATION_AUTH_ORIGINS },
    remote: { type: 'string' }, push: { type: 'boolean', default: false },
    'preview-url': { type: 'string' }, 'preview-contract-version': { type: 'string' },
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
function fail(msg: string): never { console.error(`✖ ${msg}`); process.exit(1); }
function ok(msg: string) { console.log(`✔ ${msg}`); }
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
  return { workspace, customerAuthorised: session.customerAuthorisedCrawl, allowHosts, proxy: v.proxy, headers: requestHeaders(), cookieJar: requestCookieJar(), credentialOrigins };
}
function requireStages(session: Session, ...stages: string[]): void {
  const missing = stages.filter((stage) => session.stages[stage]?.status !== 'done');
  if (missing.length) fail(`required stage(s) not complete: ${missing.join(', ')}`);
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

interface AcquiredPage { url: string; finalUrl?: string; contentType?: string; body?: string; markdown?: string; title?: string }
function acquiredPath(workspace: string, pageId: string): string { return join(workspace, 'source-cache', 'acquired', `${pageId}.json`); }

function readComponentPlan(workspace: string): Record<string, ComponentPlanEntry> {
  const p = join(workspace, 'plan', 'component-plan.yaml');
  if (!existsSync(p)) return {};
  const y = parseYaml(readFileSync(p, 'utf8')) as { components: Array<ComponentPlanEntry & { signature?: { hash?: string } }> };
  const out: Record<string, ComponentPlanEntry> = {};
  // the engine looks entries up by the full signature hash recorded in the plan
  for (const c of y.components ?? []) if (c.signature?.hash) out[c.signature.hash] = c;
  return out;
}

async function main() {
  switch (cmd) {
    case 'init': {
      const workspace = ws();
      assertOutsidePlugin(workspace, PLUGIN_ROOT);
      if (!v.source) fail('--source is required');
      if (v.target !== 'customer-org' && v.target !== 'demo-org') fail('--target must be customer-org or demo-org');
      ensureWorkspace(workspace);
      const contract = loadContract();
      const allowedOrgs = v['allowed-orgs']!.split(',').map((s) => s.trim()).filter(Boolean);
      const checks = await preflight({ target: { landing: v.target }, allowedRemoteOrgs: allowedOrgs, daiApiBase: process.env.DAI_API_BASE, daiApiKey: process.env.DAI_API_KEY });
      for (const c of checks) console.log(`  ${c.status === 'ok' ? '✔' : c.status === 'fail' ? '✖' : '·'} ${c.id}: ${c.detail}`);
      if (checks.some((c) => c.status === 'fail')) fail('preflight failed');
      const session: Session = {
        migrationId: newMigrationId(), createdAt: new Date().toISOString(),
        source: {
          kind: v.export ? 'export' : v.repo ? 'repo' : /^https?:\/\//.test(v.source!) ? 'url' : existsSync(v.source!) && statSync(v.source!).isDirectory() ? 'repo' : 'export',
          location: v.export ?? v.repo ?? v.source!, platform: v.platform,
        },
        target: { landing: v.target as 'customer-org' | 'demo-org' },
        scope: 'full', customerAuthorisedCrawl: !!v['customer-authorised'],
        versions: { core: CORE_VERSION, contentContract: contract.contractVersion, parsers: { htmlparser2: '10' } },
        hashes: {}, stages: {},
      };
      writeSession(workspace, session);
      writeJson(join(workspace, 'plan', 'allowed-orgs.json'), allowedOrgs);
      ok(`session ${session.migrationId} at ${workspace} (landing: ${session.target.landing})`);
      break;
    }
    case 'fingerprint': {
      const workspace = ws(); const s = readSession(workspace);
      let html: string | undefined; let paths: string[] | undefined;
      const src = v.url ?? v.export ?? v.repo ?? s.source.location;
      if (/^https?:\/\//.test(src)) { const f = new Fetcher({ workspace, customerAuthorised: s.customerAuthorisedCrawl }); html = (await f.get(src)).body; }
      else if (existsSync(src)) { const root = await extractIfZip(src, join(workspace, 'source-cache', 'export')); const walk = (d: string, out: string[] = []): string[] => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) { if (out.length < 5000) walk(p, out); } else out.push(p.slice(root.length + 1)); } return out; }; paths = walk(root); }
      const fp = fingerprint({ html, paths });
      writeJson(join(workspace, 'plan', 'fingerprint.json'), fp);
      if (fp.best) ok(`${fp.best.platform} (${fp.best.confidence.toFixed(2)}) matched ${fp.best.matched.join(', ')}`);
      if (fp.ambiguous) console.log(`⏸ ambiguous: ${fp.reason}. Pass --platform to init or choose a skill explicitly.`);
      else if (!s.source.platform) { s.source.platform = fp.best!.platform; s.source.platformConfidence = fp.best!.confidence; writeSession(workspace, s); }
      break;
    }
    case 'discover': {
      const workspace = ws(); const s = readSession(workspace);
      const platform = s.source.platform ?? v.platform;
      let tree: Tree;
      if (v.export ?? (s.source.kind === 'export' ? s.source.location : undefined)) {
        const src = v.export ?? s.source.location;
        const root = await extractIfZip(src, join(workspace, 'source-cache', 'export'));
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
          tree = repoTree(resolve(url), platform ?? 'generic');
          ok(`${tree.pages.length} Markdown, MDX, and HTML pages discovered in the source repository`);
        } else {
          const origin = new URL(url).origin;
          const host = new URL(url).hostname;
          const f = new Fetcher({ workspace, customerAuthorised: s.customerAuthorisedCrawl, allowHosts: [host] });
          const reasons = new Map<string, Set<string>>();
          const add = (u: string, reason: string) => {
            try {
              const parsed = new URL(u, origin);
              if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) return;
              parsed.hash = '';
              const clean = parsed.toString();
              if (!reasons.has(clean)) reasons.set(clean, new Set());
              reasons.get(clean)!.add(reason);
            } catch { /* malformed discovery URL */ }
          };
          (await sitemapUrls(f, origin)).forEach((u) => add(u, 'sitemap'));
          const seed = await f.get(url);
          for (const a of findAll(parseHtml(seed.body), 'a[href]')) if (a.attribs.href) add(a.attribs.href, 'seed-link');
          if (v.fetcher === 'firecrawl' && process.env.FIRECRAWL_API_KEY) {
            const fc = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY, workspace });
            (await fc.map(url)).forEach((u) => add(u, 'firecrawl-map'));
          }
          add(url, 'seed');
          const pages: TreePage[] = [...reasons.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([u, why], i) => {
            const parsed = new URL(u);
            const parts = parsed.pathname.split('/').filter(Boolean);
            return { id: pageIdFromPlatform(platform ?? 'generic', u), title: decodeURIComponent(parts.at(-1) ?? 'index').replace(/[-_]+/g, ' '), source: u, group: parts.slice(0, -1).map((x) => decodeURIComponent(x).replace(/[-_]+/g, ' ')), order: i, oldPath: parsed.pathname, migrate: true, reason: [...why].sort().join('+') };
          });
          tree = { scope: 'full', platform: platform ?? 'generic', pages };
          ok(`${pages.length} unique URLs from sitemap, seed link graph, and configured map sources`);
        }
      }
      writeTree(workspace, tree);
      markStage(workspace, 'discover', 'done');
      console.log(`⏸ review ${join(workspace, 'plan', 'tree.yaml')}: set migrate: false on out-of-scope pages, scope: partial if so`);
      break;
    }
    case 'acquire': {
      const workspace = ws(); const s = readSession(workspace); const tree = readTree(workspace);
      requireStages(s, 'discover');
      if (s.source.kind === 'repo' || s.source.kind === 'export') { markStage(workspace, 'acquire', 'done', 'native source; no network acquisition'); ok('native source is already local; no network acquisition needed'); break; }
      const profile = getProfile(v.profile ?? tree.platform);
      let pages = tree.pages.filter((p) => p.migrate && /^https?:\/\//.test(p.source));
      if (v.urls) {
        const selectedRaw = readJson<unknown>(resolve(v.urls));
        const selected = new Set(Array.isArray(selectedRaw) ? selectedRaw.map(String) : Array.isArray((selectedRaw as any)?.urls) ? (selectedRaw as any).urls.map(String) : []);
        pages = pages.filter((p) => selected.has(p.source));
      }
      const dir = join(workspace, 'source-cache', 'acquired'); mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (v.fetcher === 'firecrawl') {
        if (!process.env.FIRECRAWL_API_KEY) fail('FIRECRAWL_API_KEY is required for --fetcher firecrawl');
        const fc = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY, workspace });
        const got = await fc.batchScrape(pages.map((p) => p.source));
        const byUrl = new Map(got.map((p) => [p.url.replace(/\/$/, ''), p]));
        for (const page of pages) {
          const result = byUrl.get(page.source.replace(/\/$/, ''));
          if (!result) fail(`acquisition result missing for ${page.source}`);
          writeJson(acquiredPath(workspace, page.id), result);
        }
      } else {
        const host = new URL(s.source.location).hostname;
        const fetcher = new Fetcher({ workspace, customerAuthorised: s.customerAuthorisedCrawl, allowHosts: [host] });
        for (const page of pages) {
          let result;
          if (profile.mdSuffix) {
            const mdUrl = /\.md$/i.test(page.source) ? page.source : page.source.replace(/\/$/, '') + '.md';
            try {
              const md = await fetcher.get(mdUrl);
              if (md.status === 200 && md.body.trim()) result = { url: page.source, finalUrl: md.finalUrl, contentType: md.contentType, markdown: md.body };
            } catch { /* fall through to HTML */ }
          }
          if (!result) {
            const html = await fetcher.get(page.source);
            if (html.status < 200 || html.status >= 300) fail(`HTTP ${html.status} for ${page.source}`);
            result = { url: page.source, finalUrl: html.finalUrl, contentType: html.contentType, body: html.body };
          }
          writeJson(acquiredPath(workspace, page.id), result);
        }
      }
      markStage(workspace, 'acquire', 'done', `${pages.length} pages frozen`);
      ok(`${pages.length} pages acquired into source-cache/acquired`);
      break;
    }
    case 'inventory': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'discover');
      if (s.source.kind === 'url') requireStages(s, 'acquire');
      const tree = readTree(workspace);
      const inScope = tree.pages.filter((p) => p.migrate);
      const docs: DocIR[] = [];
      let root = resolve(s.source.location);
      if (tree.platform === 'document360' && s.source.kind === 'export') {
        const cachedRoot = join(workspace, 'source-cache', 'export');
        const exp = readD360Export(existsSync(cachedRoot) ? cachedRoot : root);
        root = exp.root;
        const byId = new Map(exp.articles.map((a) => [pageIdFromPlatform('document360', a.platformId), a]));
        for (const p of inScope) { const article = byId.get(p.id); if (article) docs.push(d360ArticleToIr(article, exp.root)); }
      } else if (s.source.kind === 'repo') {
        const profile = getProfile(tree.platform);
        for (const p of inScope) {
          const file = resolve(root, p.source);
          if (file !== root && !file.startsWith(root + '/')) fail(`source page escapes repository: ${p.source}`);
          const raw = readFileSync(file, 'utf8');
          if (/\.mdx?$/i.test(file)) docs.push(markdownToIr(raw, { platform: tree.platform, file: p.source, pageId: p.id, title: p.title }));
          else {
            const ir = htmlToIr(raw, { platform: tree.platform, file: p.source, articleSelector: profile.articleSelector, removeSelectors: profile.removeSelectors, recognisers: profile.recognisers });
            docs.push({ pageId: p.id, platform: tree.platform, source: p.source, frontmatter: { title: p.title }, children: ir.children });
          }
        }
      } else {
        const profile = getProfile(tree.platform);
        for (const p of inScope) {
          const cached = acquiredPath(workspace, p.id);
          if (!existsSync(cached)) fail(`acquired page missing for ${p.source}; run dai-migrate acquire first`);
          const page = readJson<AcquiredPage>(cached);
          if (page.markdown) docs.push(markdownToIr(page.markdown, { platform: tree.platform, file: p.source, pageId: p.id, title: page.title ?? p.title }));
          else {
            const ir = htmlToIr(page.body ?? '', { platform: tree.platform, file: p.source, articleSelector: profile.articleSelector, removeSelectors: profile.removeSelectors, recognisers: profile.recognisers });
            docs.push({ pageId: p.id, platform: tree.platform, source: p.source, frontmatter: { title: page.title ?? p.title }, children: ir.children });
          }
        }
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
      const assetsPlan = { provider: v.provider ?? 'local', generateAlt: false, iframeHosts: ['www.youtube.com', 'youtube.com', 'youtu.be', 'player.vimeo.com', 'www.loom.com'] };
      const ap = join(workspace, 'plan', 'assets.yaml'); if (!existsSync(ap)) writeFileSync(ap, toYaml(assetsPlan), { mode: 0o600 });
      s.hashes.componentPlan = fileHash(planPath); s.hashes.urlPlan = fileHash(join(workspace, 'plan', 'urls.yaml')); writeSession(workspace, s);
      markStage(workspace, 'plan', 'done');
      const needs = components.filter((c) => c.status === 'needs-review').length;
      ok(`component plan: ${components.length} clusters, ${needs} need review; url plan: ${urlPlan.pages.length} pages (${urlPlan.mode})`);
      console.log(`⏸ review plan/component-plan.yaml, plan/urls.yaml, plan/assets.yaml, inventory/snippets.json (blocked tokens)`);
      break;
    }
    case 'assets': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'inventory');
      const docs = loadSnapshot(workspace);
      const fetcher = new Fetcher({ workspace, customerAuthorised: s.customerAuthorisedCrawl });
      let localResolver: ((url: string) => string | undefined) | undefined;
      if (s.source.kind === 'export' && (s.source.platform === 'document360' || readTree(workspace).platform === 'document360')) {
        const root = join(workspace, 'source-cache', 'export');
        const exp = readD360Export(existsSync(root) ? root : s.source.location);
        localResolver = d360MediaResolver(exp.mediaDir);
      }
      const m = await collectAssets(docs, workspace, { fetcher, localResolver, provider: v.provider });
      const entries = Object.values(m.entries);
      markStage(workspace, 'assets', 'done');
      ok(`${entries.length} assets: ${entries.filter((e) => e.status === 'downloaded').length} downloaded, ${entries.filter((e) => e.status === 'kept-external').length} kept external, ${entries.filter((e) => e.status === 'failed').length} failed; ${entries.reduce((n, e) => n + e.altMissing, 0)} references without alt`);
      if (v.provider === 'local' || !v.provider) console.log('· provider local: final URLs are assigned when the dai-api ingestion (G7) or an s3 provider is configured; output keeps source URLs until then');
      break;
    }
    case 'convert': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'plan', 'assets');
      const tree = applyUrlPlan(readTree(workspace), readUrlPlan(workspace) ?? defaultUrlPlan(readTree(workspace)));
      const docs = loadSnapshot(workspace);
      const manifest = readManifest(workspace);
      const plan = readComponentPlan(workspace);
      const assetsPlan = existsSync(join(workspace, 'plan', 'assets.yaml')) ? (parseYaml(readFileSync(join(workspace, 'plan', 'assets.yaml'), 'utf8')) as { iframeHosts?: string[] }) : {};
      // fresh ledger and log per convert run
      for (const f of ['ledger/dispositions.jsonl', 'logging/decisions.jsonl']) { const p = join(workspace, f); if (existsSync(p)) writeFileSync(p, ''); }
      const ledger = new Ledger(workspace); const log = new DecisionLog(workspace, !!v['log-originals']);
      const engine = new RulesEngine({ platform: tree.platform, mappings: loadMappings(mappingPaths(tree.platform)), plan, ledger, log, iframeHosts: assetsPlan.iframeHosts });
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
      let converted = 0; let blocked = 0;
      for (const doc of docs) {
        const page = byId.get(doc.pageId); if (!page || !page.migrate || !page.newPath) continue;
        const hasBlocked = [...blockedTokens].some((t) => JSON.stringify(doc.children).includes(`UNRESOLVED SNIPPET ${t}`) || JSON.stringify(doc.children).includes(`"token":"${t}"`));
        if (hasBlocked) {
          blocked++;
          walkBlocks(doc.children, (n) => { ledger.quarantined(doc.pageId, n.id, 'page held: blocked snippet token(s) unresolved'); });
          writeJson(join(qDir, `${doc.pageId}.json`), { reason: 'blocked snippet token(s) unresolved', page: page.newPath });
          continue;
        }
        const withSnippets = inlineSnippetBodies(doc, snippets);
        const resolved = engine.resolveDoc(rewriteAssetRefs(withSnippets, manifest));
        const mdx = docToMdx(resolved, { anchorShims: shims.get(doc.pageId) });
        const outPath = join(outDir, `${page.newPath}.mdx`);
        mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
        writeFileSync(outPath, mdx, { mode: 0o600 });
        converted++;
      }
      s.hashes.componentPlan = fileHash(join(workspace, 'plan', 'component-plan.yaml'));
      s.hashes.urlPlan = fileHash(join(workspace, 'plan', 'urls.yaml'));
      s.hashes.assetPlan = fileHash(join(workspace, 'plan', 'assets.yaml'));
      s.hashes.canonicalOutput = undefined;
      writeSession(workspace, s);
      markStage(workspace, 'convert', 'done', `${converted} converted, ${blocked} blocked`);
      ok(`${converted} pages written to output/, ${blocked} pages held (blocked snippet tokens)`);
      break;
    }
    case 'nav': {
      const workspace = ws(); const s = readSession(workspace); requireStages(s, 'convert');
      const tree = applyUrlPlan(readTree(workspace), readUrlPlan(workspace) ?? defaultUrlPlan(readTree(workspace)));
      const nav = buildNavigation(tree.pages.filter((p) => existsSync(join(workspace, 'output', `${p.newPath}.mdx`))));
      const docJsonPath = join(workspace, 'output', 'documentation.json');
      const existing = existsSync(docJsonPath) ? readJson<Record<string, unknown>>(docJsonPath) : { name: 'Documentation', initialRoute: `/${tree.pages.find((p) => p.migrate && p.newPath)?.newPath ?? ''}` };
      writeJson(docJsonPath, { ...existing, ...nav });
      const plan = readUrlPlan(workspace)!;
      const r = redirectMaps(plan);
      writeJson(join(workspace, 'report', 'redirects.exact.json'), r.exact);
      writeJson(join(workspace, 'report', 'redirects.wildcard.json'), r.wildcard);
      const anchors = existsSync(join(workspace, 'inventory', 'anchors.json')) ? readJson<Array<{ pageId: string; headings: Array<{ id: string; text: string; sourceId?: string }> }>>(join(workspace, 'inventory', 'anchors.json')) : [];
      const links = existsSync(join(workspace, 'inventory', 'links.json')) ? readJson<Array<{ pageId: string; url: string }>>(join(workspace, 'inventory', 'links.json')) : [];
      const inbound = new Map<string, number>();
      for (const l of links) { const h = l.url.split('#')[1]; if (h) inbound.set(`#${h}`, (inbound.get(`#${h}`) ?? 0) + 1); }
      const am = anchorMap(anchors, inbound);
      writeJson(join(workspace, 'report', 'anchors.json'), am.entries);
      markStage(workspace, 'nav', 'done');
      ok(`documentation.json written; ${r.exact.length} exact redirects, ${r.wildcard.length} wildcard candidates, ${r.issues.length} issues; ${am.entries.filter((e) => e.needsShim).length} headings need anchor shims`);
      console.log(`⏸ review output/documentation.json, plan/urls.yaml, report/redirects.*.json`);
      break;
    }
    case 'write': {
      const workspace = ws(); const s = readSession(workspace);
      requireStages(s, 'nav');
      if (!v.repo) fail('--repo <dir> is required');
      if (v.push) {
        const gateFile = join(workspace, 'report', 'gates.json');
        if (!existsSync(gateFile)) fail('--push requires a completed verify run');
        const currentOutputHash = canonicalHash(join(workspace, 'output'));
        if (!s.hashes.canonicalOutput || currentOutputHash !== s.hashes.canonicalOutput) fail('--push refused: output changed after deterministic verification; rerun verify twice');
        const pinnedPlans = [
          ['component-plan.yaml', s.hashes.componentPlan],
          ['urls.yaml', s.hashes.urlPlan],
          ['assets.yaml', s.hashes.assetPlan],
        ] as const;
        const stalePlans = pinnedPlans.filter(([file, expected]) => !expected || !existsSync(join(workspace, 'plan', file)) || fileHash(join(workspace, 'plan', file)) !== expected).map(([file]) => file);
        if (stalePlans.length) fail(`--push refused: plan changed after conversion (${stalePlans.join(', ')}); rerun convert and verify`);
        const gateReport = readJson<{ pass: boolean; gates: GateResult[] }>(gateFile);
        const blockers = previewPushBlockers(gateReport.gates);
        if (blockers.length) fail(`--push refused: non-preview gates must pass first (${blockers.map((g) => g.id).join(', ')})`);
        if (!gateReport.pass) console.log('· pushing the migration branch to create a preview; rendered-preview gates remain required before release');
      }
      const allowed = existsSync(join(workspace, 'plan', 'allowed-orgs.json')) ? readJson<string[]>(join(workspace, 'plan', 'allowed-orgs.json')) : [];
      const r = writeMigrationBranch({ repoDir: resolve(v.repo), outputDir: join(workspace, 'output'), sessionId: s.migrationId, remote: v.remote, allowedRemoteOrgs: allowed, push: !!v.push });
      s.target.repoRemote = v.remote ?? s.target.repoRemote; writeSession(workspace, s);
      markStage(workspace, 'write', 'done', `${r.branch}@${r.commit.slice(0, 8)}`);
      ok(`${r.branch} at ${r.commit.slice(0, 8)}${r.pushed ? ' (pushed)' : ' (not pushed; add --push)'}`);
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
      const gates = runGates({
        workspace, outputDir: join(workspace, 'output'),
        sourceDocs: docs.map((doc) => ({ doc, outputFile: byId.get(doc.pageId)?.newPath ? join(workspace, 'output', `${byId.get(doc.pageId)!.newPath}.mdx`) : undefined })),
        treePages: tree.pages, quarantinedPages: quarantined, excludedPages: new Set(), unreviewed,
        previousCanonicalHash: s.hashes.canonicalOutput, previewUrl: v['preview-url'], pinnedContractVersion: s.versions.contentContract, previewContractVersion: v['preview-contract-version'],
      });
      if (v['preview-url']) {
        const anchorFile = join(workspace, 'report', 'anchors.json');
        const browserAnchors = existsSync(anchorFile) ? readJson<BrowserAnchor[]>(anchorFile) : [];
        const browser = await runBrowserFragmentGate(v['preview-url'], tree.pages, browserAnchors);
        const index = gates.findIndex((g) => g.id === 'browser-fragments');
        if (index >= 0) gates[index] = browser; else gates.push(browser);
      }
      const pinnedPlans = [
        ['component-plan.yaml', s.hashes.componentPlan],
        ['urls.yaml', s.hashes.urlPlan],
        ['assets.yaml', s.hashes.assetPlan],
      ] as const;
      const changedPlans = pinnedPlans.filter(([file, expected]) => !expected || !existsSync(join(workspace, 'plan', file)) || fileHash(join(workspace, 'plan', file)) !== expected).map(([file]) => file);
      gates.unshift({ id: 'plans-pinned', status: changedPlans.length ? 'fail' : 'pass', detail: changedPlans.length ? `plan changed after conversion: ${changedPlans.join(', ')}; rerun convert` : 'component, URL and asset plans match the converted snapshot', count: changedPlans.length, samples: changedPlans });
      writeGates(workspace, gates);
      const clusters = existsSync(join(workspace, 'inventory', 'components.json')) ? readJson<ClusterEntry[]>(join(workspace, 'inventory', 'components.json')) : [];
      writeReviewQueue(workspace, gates, clusters, Object.fromEntries(Object.entries(plan).map(([k, c]) => [k, c.status ?? 'auto'])));
      if (!s.hashes.canonicalOutput) { s.hashes.canonicalOutput = canonicalHash(join(workspace, 'output')); writeSession(workspace, s); }
      for (const g of gates) console.log(`  ${g.status === 'pass' ? '✔' : g.status === 'fail' ? '✖' : '·'} ${g.id}: ${g.detail}`);
      const blocked = gates.filter((g) => g.status !== 'pass').length;
      markStage(workspace, 'verify', blocked ? 'failed' : 'done', `${blocked} failing or not run`);
      console.log(blocked ? `✖ ${blocked} gate(s) failing or not run; release is blocked; see report/review-queue.md` : '✔ all release gates pass');
      if (blocked) process.exitCode = 2;
      break;
    }
    case 'report': {
      const workspace = ws(); const s = readSession(workspace);
      const tree = applyUrlPlan(readTree(workspace), readUrlPlan(workspace) ?? defaultUrlPlan(readTree(workspace)));
      const gates = existsSync(join(workspace, 'report', 'gates.json')) ? readJson<{ gates: any[] }>(join(workspace, 'report', 'gates.json')).gates : [];
      const clusters = existsSync(join(workspace, 'inventory', 'components.json')) ? readJson<ClusterEntry[]>(join(workspace, 'inventory', 'components.json')) : [];
      const manifest = readManifest(workspace);
      const qDir = join(workspace, 'quarantine');
      const decisions = readDecisions(workspace);
      const shims = existsSync(join(workspace, 'report', 'anchors.json')) ? readJson<Array<{ needsShim: boolean }>>(join(workspace, 'report', 'anchors.json')).filter((a) => a.needsShim).length : 0;
      writePlatformGaps(workspace, decisions, shims);
      writeSummary(workspace, { pages: tree.pages.filter((p) => p.migrate).length, converted: tree.pages.filter((p) => p.migrate && p.newPath && existsSync(join(workspace, 'output', `${p.newPath}.mdx`))).length, quarantined: existsSync(qDir) ? readdirSync(qDir).length : 0, clusters: clusters.length, assets: Object.keys(manifest.entries).length, gates, branch: s.stages.write?.note });
      markStage(workspace, 'report', 'done');
      ok('report/summary.md and report/platform-gaps.json written');
      break;
    }
    default: fail(`unknown command ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => fail((e as Error).message));
