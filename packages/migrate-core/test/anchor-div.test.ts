import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToIr } from '../src/ir/from-html.js';
import { PROFILES, htmlAdapterOptions } from '../src/scrape/profiles.js';
import { RulesEngine, loadMappings } from '../src/components/rules-engine.js';
import { Ledger } from '../src/ledger/dispositions.js';
import { DecisionLog } from '../src/log/decisions.js';
import { ensureWorkspace } from '../src/session/workspace.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import type { DocIR } from '../src/ir/types.js';
import { markdownToIr } from '../src/ir/from-markdown.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('Mintlify anchor divs', () => {
  it('writes an empty id-div as the anchor element an older link still uses', () => {
    const html = '<main><h3 id="draft-changelog">Draft changelog</h3><p>Creates an entry.</p><div id="draft-improvements-from-assistant-conversations"></div><h3 id="fill-gaps">Fill gaps</h3></main>';
    const ir = htmlToIr(html, htmlAdapterOptions(PROFILES.mintlify ?? PROFILES.generic, { platform: 'mintlify', file: 'https://docs.example.com/a' }));
    const doc: DocIR = { pageId: 'p', platform: 'mintlify', source: 'https://docs.example.com/a', frontmatter: { title: 'A' }, children: ir.children };
    const w = mkdtempSync(join(tmpdir(), 'dai-anchor-div-')); ensureWorkspace(w);
    const engine = new RulesEngine({ platform: 'mintlify', mappings: loadMappings([join(repoRoot, 'skills/migrate-mintlify/mappings/mintlify.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
    const mdx = docToMdx(engine.resolveDoc(doc));
    expect(mdx).toContain('<a id="draft-improvements-from-assistant-conversations"></a>');
    expect(mdx).not.toContain('QUARANTINED');
    expect(mdx).toContain('### Fill gaps');
  });
  it('does the same for the div in a Markdown export', () => {
    const doc = markdownToIr('---\ntitle: A\n---\n\n### Draft changelog\n\nCreates an entry.\n\n<div id="draft-improvements-from-assistant-conversations"></div>\n\n### Fill gaps\n', { platform: 'mintlify', file: 'a.md', pageId: 'p' });
    const w = mkdtempSync(join(tmpdir(), 'dai-anchor-div-')); ensureWorkspace(w);
    const engine = new RulesEngine({ platform: 'mintlify', mappings: loadMappings([join(repoRoot, 'skills/migrate-mintlify/mappings/mintlify.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
    const mdx = docToMdx(engine.resolveDoc(doc));
    expect(mdx).toContain('<a id="draft-improvements-from-assistant-conversations"></a>');
    expect(mdx).not.toContain('QUARANTINED');
  });
});

describe('prompt-to-code', () => {
  it('copies the whole prompt, numbered list included', () => {
    const doc = markdownToIr('---\ntitle: A\n---\n\n<Prompt description="Install a skill." actions={["copy"]}>\n  Install the skill into my agent.\n\n  1. Ask me for the URL, then run `npx skills add <url>`.\n  2. Print the installed skills.\n</Prompt>\n', { platform: 'mintlify', file: 'a.mdx', pageId: 'p' });
    const w = mkdtempSync(join(tmpdir(), 'dai-prompt-')); ensureWorkspace(w);
    const engine = new RulesEngine({ platform: 'mintlify', mappings: loadMappings([join(repoRoot, 'skills/migrate-mintlify/mappings/mintlify.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
    const mdx = docToMdx(engine.resolveDoc(doc));
    expect(mdx).toContain('Install a skill.');
    expect(mdx).toContain('```text\nInstall the skill into my agent.\n\n1. Ask me for the URL, then run npx skills add <url>.\n2. Print the installed skills.\n```');
  });
});

describe('footnote bodies in the ledger', () => {
  it('give every block inside a footnote its own disposition', async () => {
    const { Ledger } = await import('../src/ledger/dispositions.js');
    const doc = markdownToIr('---\ntitle: A\n---\n\nText[^n].\n\n[^n]: First paragraph.\n\n    Second paragraph.\n', { platform: 'gitbook', file: 'a.md', pageId: 'p' });
    const w = mkdtempSync(join(tmpdir(), 'dai-fn-')); ensureWorkspace(w);
    const ledger = new Ledger(w);
    const engine = new RulesEngine({ platform: 'gitbook', mappings: loadMappings([join(repoRoot, 'skills/migrate-gitbook/mappings/gitbook.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger, log: new DecisionLog(w) });
    engine.resolveDoc(doc);
    const recorded = new Set(Ledger.read(w).map((d) => d.sourceNodeId));
    const definition = doc.children[1] as Extract<typeof doc.children[number], { type: 'footnoteDefinition' }>;
    expect(definition.type).toBe('footnoteDefinition');
    for (const block of definition.children) expect(recorded.has(block.id)).toBe(true);
  });
});
