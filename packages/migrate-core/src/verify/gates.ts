/**
 * Release gates. Any failure blocks release. Gates that need a preview or a
 * browser report `not-run` and count as failed unless explicitly allowed.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validateMdx, validateNavigation } from '@dai/content-contract';
import { Ledger, summarize, type LedgerSummary } from '../ledger/dispositions.js';
import type { DocIR } from '../ir/types.js';
import { walkBlocks, inlineText } from '../ir/types.js';
import { redirectMaps, readUrlPlan } from '../urls/plan.js';
import { sha256 } from '../session/ids.js';
import { isSafeUrl } from '../components/sanitize.js';
import { readManifest } from '../assets/manifest.js';

export interface GateResult { id: string; status: 'pass' | 'fail' | 'not-run'; detail: string; count?: number; samples?: string[] }

const PREVIEW_ONLY_GATES = new Set(['preview-contract-version', 'browser-fragments']);
export const REQUIRED_RELEASE_GATE_IDS = [
  'plans-pinned', 'pages-accounted', 'block-dispositions', 'exclusions-attributed',
  'no-unsafe-urls', 'assets-ready', 'prose-match', 'code-blocks-exact', 'tables-exact',
  'contract-valid', 'navigation-valid', 'internal-links', 'no-unresolved-blocks',
  'redirects-clean', 'no-unreviewed-decisions', 'deterministic-rerun',
  'preview-contract-version', 'browser-fragments',
] as const;

/** A migration branch may be pushed to create its preview only after every
 * non-preview gate passes. Final release still requires every gate to pass. */
export function previewPushBlockers(gates: GateResult[]): GateResult[] {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const missing = REQUIRED_RELEASE_GATE_IDS.filter((id) => !byId.has(id)).map((id): GateResult => ({ id, status: 'fail', detail: 'required gate result is missing' }));
  return [...missing, ...gates.filter((gate) => gate.status !== 'pass' && !(gate.status === 'not-run' && PREVIEW_ONLY_GATES.has(gate.id)))];
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
export function proseSegments(doc: DocIR): string[] {
  const segs: string[] = [];
  const norm = (s: string) => normaliseMdxText(s).trim();
  walkBlocks(doc.children, (b) => {
    if (b.type === 'paragraph' || b.type === 'heading') { const t = norm(inlineText(b.children)); if (t.length >= 12) segs.push(t); }
    else if (b.type === 'table') for (const r of b.children) for (const c of r.children) { const t = norm(inlineText(c.children)); if (t.length >= 12) segs.push(t); }
  });
  return segs;
}

export function normaliseMdxText(mdx: string): string {
  return mdx
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\{[^{}\n]*\}/g, ' ')
    .replace(/<Image\b[^>]*\balt="([^"]*)"[^>]*\/?>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`\\]+/g, '')
    .replace(/[#>|-]+/g, ' ')
    .replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase();
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
    if (b.type === 'table') out.push(JSON.stringify(b.children.map((row) => row.children.map((cell) => tableCellText(inlineText(cell.children))))));
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
  const lines = mdx.split(/\r?\n/);
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

export interface GateInput {
  workspace: string;
  outputDir: string;
  /** Source docs from the snapshot (IR JSON). */
  sourceDocs: Array<{ doc: DocIR; outputFile?: string }>;
  treePages: Array<{ id: string; migrate: boolean; newPath?: string }>;
  quarantinedPages: Set<string>;
  excludedPages: Set<string>;
  unreviewed: number;
  /** Hash of the last convert and of the convert before it over identical inputs; both are convert-time hashes. */
  previousCanonicalHash?: string;
  convertOutputHash?: string;
  previewUrl?: string;
  pinnedContractVersion: string;
  previewContractVersion?: string;
}

export function canonicalHash(outputDir: string): string {
  const files = listMdx(outputDir).concat(existsSync(join(outputDir, 'documentation.json')) ? [join(outputDir, 'documentation.json')] : []).sort();
  const h = files.map((f) => `${relative(outputDir, f)}\n${sha256(readFileSync(f))}`).join('\n');
  return sha256(h);
}

export function runGates(input: GateInput): GateResult[] {
  const gates: GateResult[] = [];
  const outMdx = listMdx(input.outputDir);
  const outByPath = new Map(outMdx.map((f) => [relative(input.outputDir, f).replace(/\.mdx?$/, ''), f]));

  // 1. pages accounted
  const scoped = input.treePages.filter((p) => p.migrate);
  const unaccounted = scoped.filter((p) => !(p.newPath && outByPath.has(p.newPath)) && !input.quarantinedPages.has(p.id) && !input.excludedPages.has(p.id));
  gates.push({ id: 'pages-accounted', status: unaccounted.length ? 'fail' : 'pass', detail: `${scoped.length - unaccounted.length}/${scoped.length} scoped pages converted, excluded or quarantined`, count: unaccounted.length, samples: unaccounted.slice(0, 5).map((p) => p.id) });

  // 2. ledger coverage
  const ids: Array<{ pageId: string; nodeId: string }> = [];
  for (const { doc } of input.sourceDocs) walkBlocks(doc.children, (n) => { ids.push({ pageId: doc.pageId, nodeId: n.id }); });
  const summary: LedgerSummary = summarize(Ledger.read(input.workspace), ids);
  gates.push({ id: 'block-dispositions', status: summary.missing.length ? 'fail' : 'pass', detail: `${summary.covered}/${summary.totalSource} source blocks have a disposition (identical ${summary.identical}, transformed ${summary.transformed}, excluded ${summary.excluded}, quarantined ${summary.quarantined})`, count: summary.missing.length, samples: summary.missing.slice(0, 5).map((m) => m.sourceNodeId) });
  gates.push({ id: 'exclusions-attributed', status: summary.excludedUnattributed ? 'fail' : 'pass', detail: `${summary.excludedUnattributed} exclusions without reviewer`, count: summary.excludedUnattributed });

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
  let unmatched = 0; const unmatchedSamples: string[] = [];
  let codeMismatch = 0; const codeSamples: string[] = [];
  let tableMismatch = 0; const tableSamples: string[] = [];
  for (const { doc, outputFile } of input.sourceDocs) {
    if (!outputFile || !existsSync(outputFile)) continue;
    const mdx = readFileSync(outputFile, 'utf8');
    const hay = normaliseMdxText(mdx);
    for (const seg of proseSegments(doc)) if (!hay.includes(seg)) { unmatched++; if (unmatchedSamples.length < 5) unmatchedSamples.push(`${doc.source}: "${seg.slice(0, 60)}"`); }
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
  gates.push({ id: 'code-blocks-exact', status: codeMismatch ? 'fail' : 'pass', detail: `${codeMismatch} code blocks changed`, count: codeMismatch, samples: codeSamples });
  gates.push({ id: 'tables-exact', status: tableMismatch ? 'fail' : 'pass', detail: `${tableMismatch} source table cell matrices changed`, count: tableMismatch, samples: tableSamples });

  // 4. strict validator on every output file
  let errors = 0; const errSamples: string[] = [];
  for (const f of outMdx) for (const i of validateMdx(readFileSync(f, 'utf8'))) if (i.severity === 'error') { errors++; if (errSamples.length < 8) errSamples.push(`${relative(input.outputDir, f)}:${i.line ?? '-'} ${i.code}: ${i.message}`); }
  gates.push({ id: 'contract-valid', status: errors ? 'fail' : 'pass', detail: `${errors} strict-validator errors across ${outMdx.length} files`, count: errors, samples: errSamples });

  // 5. navigation
  const navFile = join(input.outputDir, 'documentation.json');
  if (existsSync(navFile)) {
    const nav = JSON.parse(readFileSync(navFile, 'utf8'));
    const navIssues = validateNavigation(nav, (p) => outByPath.has(p.replace(/^\//, '')));
    gates.push({ id: 'navigation-valid', status: navIssues.length ? 'fail' : 'pass', detail: `${navIssues.length} navigation issues`, count: navIssues.length, samples: navIssues.slice(0, 5).map((i) => i.message) });
  } else gates.push({ id: 'navigation-valid', status: 'fail', detail: 'documentation.json missing' });

  // 6. internal links resolve
  let broken = 0; const brokenSamples: string[] = [];
  for (const f of outMdx) {
    const mdx = readFileSync(f, 'utf8');
    for (const m of mdx.matchAll(/\]\((\/[^)#\s]*)(#[^)\s]*)?\)/g)) {
      const target = m[1].replace(/\/$/, '').replace(/^\//, '');
      if (target && !outByPath.has(target) && !existsSync(join(input.outputDir, target))) { broken++; if (brokenSamples.length < 5) brokenSamples.push(`${relative(input.outputDir, f)} → ${m[1]}`); }
    }
  }
  gates.push({ id: 'internal-links', status: broken ? 'fail' : 'pass', detail: `${broken} internal links do not resolve to an output page`, count: broken, samples: brokenSamples });

  // 7. unresolved snippets / quarantine placeholders in output
  let unresolved = 0; const unresolvedSamples: string[] = [];
  for (const f of outMdx) { const n = (readFileSync(f, 'utf8').match(/UNRESOLVED SNIPPET|QUARANTINED:|UNSUPPORTED (?:INLINE COMPONENT|EXPRESSION)/g) ?? []).length; if (n) { unresolved += n; if (unresolvedSamples.length < 5) unresolvedSamples.push(relative(input.outputDir, f)); } }
  gates.push({ id: 'no-unresolved-blocks', status: unresolved ? 'fail' : 'pass', detail: `${unresolved} unresolved snippet, component, expression, or quarantine placeholders remain in output`, count: unresolved, samples: unresolvedSamples });

  // 8. redirects
  const plan = readUrlPlan(input.workspace);
  if (plan) { const r = redirectMaps(plan); gates.push({ id: 'redirects-clean', status: r.issues.length ? 'fail' : 'pass', detail: `${r.exact.length} exact rules, ${r.wildcard.length} wildcard candidates, ${r.issues.length} issues`, count: r.issues.length, samples: r.issues.slice(0, 5) }); }
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
  } else {
    gates.push({ id: 'preview-contract-version', status: 'not-run', detail: 'no preview URL' });
    gates.push({ id: 'browser-fragments', status: 'not-run', detail: 'no preview URL' });
  }
  return gates;
}
