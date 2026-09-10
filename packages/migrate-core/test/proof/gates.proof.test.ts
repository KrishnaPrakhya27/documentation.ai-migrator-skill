import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTruth, resolveSourceTruthDir } from '../helpers/source-truth.js';
import { htmlToIr } from '../../src/ir/from-html.js';
import { PROFILES, htmlAdapterOptions } from '../../src/scrape/profiles.js';
import { RulesEngine, loadMappings } from '../../src/components/rules-engine.js';
import { Ledger } from '../../src/ledger/dispositions.js';
import { DecisionLog } from '../../src/log/decisions.js';
import { ensureWorkspace } from '../../src/session/workspace.js';
import { runGates } from '../../src/verify/gates.js';
import { walkBlocks, type DocIR } from '../../src/ir/types.js';

/**
 * Exact mode forbids authored exclusions: converting every page of the real site with the
 * mappings the convert stage loads must leave no `excluded` disposition in the ledger, and
 * the no-authored-exclusions gate must pass for that reason, on a ledger that covers real
 * content rather than an empty one.
 */
const dir = resolveSourceTruthDir();
const truth = loadTruth(dir);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const htmlFile = (path: string): string => join(dir, 'html', path === '/' ? 'index.html' : `${path.slice(1)}.html`);
const renderedDoc = (path: string): DocIR => {
  const file = htmlFile(path);
  const rendered = htmlToIr(readFileSync(file, 'utf8'), htmlAdapterOptions(PROFILES.mintlify, { platform: 'mintlify', file }));
  return { pageId: path, platform: 'mintlify', source: file, frontmatter: { title: truth.pageByPath(path).title }, children: rendered.children };
};

describe('no-authored-exclusions over the demo site (proof)', () => {
  it('converts all 14 rendered pages without a single excluded disposition and passes the gate in exact mode', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dai-proof-gates-')); ensureWorkspace(ws);
    const mappings = loadMappings([join(repoRoot, 'skills/migrate-mintlify/mappings/mintlify.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]);
    const engine = new RulesEngine({ platform: 'mintlify', mappings, ledger: new Ledger(ws), log: new DecisionLog(ws) });
    const docs = truth.pages.map((page) => renderedDoc(page.path));
    expect(docs).toHaveLength(14);
    for (const doc of docs) engine.resolveDoc(doc);
    let sourceBlocks = 0;
    for (const doc of docs) walkBlocks(doc.children, () => { sourceBlocks++; });
    expect(sourceBlocks).toBeGreaterThan(14 * 4);
    expect(Ledger.read(ws).filter((d) => d.kind === 'excluded')).toEqual([]);
    const gates = runGates({ workspace: ws, outputDir: join(ws, 'output'), sourceDocs: docs.map((doc) => ({ doc })), treePages: [], quarantinedPages: new Set(), excludedPages: new Set(), unreviewed: 0, pinnedContractVersion: '0.1.0', fidelityMode: 'exact' });
    expect(gates.find((g) => g.id === 'no-authored-exclusions')).toMatchObject({ status: 'pass', count: 0, detail: '0 authored blocks excluded (0 script/style nodes dropped by rule); exact mode permits none', samples: [] });
  });
});
