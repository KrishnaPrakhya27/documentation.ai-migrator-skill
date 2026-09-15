import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToIr } from '../src/ir/from-html.js';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { blocksToMdx, docToMdx, frontmatterToYaml, inlineToMdx } from '../src/ir/to-dai-mdx.js';
import { RulesEngine, loadMappings, collectComponents, planEntryIsDecided } from '../src/components/rules-engine.js';
import { Ledger, summarize } from '../src/ledger/dispositions.js';
import { DecisionLog } from '../src/log/decisions.js';
import { walkBlocks, type DocIR } from '../src/ir/types.js';
import { D360_RECOGNISERS, parseMetadata } from '../src/adapters/document360.js';
import { clusterComponents } from '../src/components/signature.js';
import { validateMdx } from '@dai/content-contract';
import { ensureWorkspace } from '../src/session/workspace.js';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const fixture = readFileSync(join(here, 'fixtures/d360/getting-started.html'), 'utf8');

function buildDoc(): DocIR {
  const { body, metadata } = parseMetadata(fixture);
  const withTokens = body.replace(/\{\{\s*snippet\.([^}]+?)\s*\}\}/g, (_, t) => `<dai-snippet-ref data-token="${t.trim()}"></dai-snippet-ref>`);
  const res = htmlToIr(withTokens, {
    platform: 'document360',
    file: 'Articles/getting-started.html',
    recognisers: [...D360_RECOGNISERS, { selector: 'dai-snippet-ref', name: 'snippetRef', props: { token: '@attr:data-token' } }],
  });
  return { pageId: 'page-1', platform: 'document360', source: 'Articles/getting-started.html', frontmatter: { title: metadata.title, description: metadata.description }, children: res.children };
}

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'dai-test-')); ensureWorkspace(ws); });

describe('HTML → IR', () => {
  it('recognises Document360 constructs as components and keeps ids on headings', () => {
    const doc = buildDoc();
    const comps = collectComponents(doc);
    const names = comps.map((c) => c.name).sort();
    expect(names).toEqual(expect.arrayContaining(['infoBox', 'warningBox', 'details', 'faq', 'iframe', 'script']));
    const headings: string[] = [];
    walkBlocks(doc.children, (n) => { if (n.type === 'heading') headings.push(n.sourceId ?? ''); });
    expect(headings).toEqual(['overview', 'mkdmggx4-k4pnrn-005']);
  });
});

describe('Markdown/MDX → IR', () => {
  it('parses GFM and components without evaluating expressions', () => {
    const doc = markdownToIr(`---\ntitle: Guide\n---\n\n# Start\n\n<Card title="Go" cols={3}>\nBody **bold**\n</Card>\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n{dangerous.call()}\n`, { platform: 'mintlify', file: 'guide.mdx', pageId: 'p' });
    expect(doc.frontmatter.title).toBe('Guide');
    const card = collectComponents(doc).find((x) => x.name === 'Card');
    expect(card?.props).toMatchObject({ title: 'Go', cols: 3 });
    expect(JSON.stringify(doc)).not.toContain('dangerous.call()');
    expect(JSON.stringify(doc)).toContain('expression:executable');
    expect(doc.children.some((x) => x.type === 'table')).toBe(true);
  });

  it('keeps an operator decision across re-planning and recomputes a derivation', () => {
    // A rule added after the plan was written must take effect, or a migrator fix silently does nothing.
    expect(planEntryIsDecided(undefined)).toBe(false);
    expect(planEntryIsDecided({ cluster: 'a', tier: 'T7', status: 'needs-review' })).toBe(false);
    expect(planEntryIsDecided({ cluster: 'a', tier: 'T1', status: 'auto' })).toBe(false);
    // Anything a person put their name to, or decided outright, is theirs and survives untouched.
    expect(planEntryIsDecided({ cluster: 'a', tier: 'T7', status: 'needs-review', reviewer: 'someone' })).toBe(true);
    for (const status of ['approved', 'excluded', 'quarantined'] as const) {
      expect(planEntryIsDecided({ cluster: 'a', tier: 'T7', status })).toBe(true);
    }
  });

  it('reads a data literal as data and still refuses code', () => {
    // tags={["a","b"]} and rss={{title:"x"}} are values a component was given, not behaviour,
    // and holding a whole component back over decoration it never keeps is the worse answer.
    const doc = markdownToIr('<Update label="v2" tags={["New releases","Bug fixes"]} rss={{ title: "Feed" }}>\nBody\n</Update>\n', { platform: 'mintlify', file: 'a.mdx', pageId: 'p' });
    const update = collectComponents(doc).find((x) => x.name === 'Update');
    expect(update?.props).toMatchObject({ label: 'v2', tags: '["New releases","Bug fixes"]', rss: '{"title":"Feed"}' });
    expect(JSON.stringify(doc)).not.toContain('expression:tags');
    // Code has no value until something runs it, and nothing here ever runs anything.
    const code = markdownToIr('<Button onClick={() => copy(x)} value={input} id={`k-${i}`} />\n', { platform: 'mintlify', file: 'b.mdx', pageId: 'p' });
    const button = collectComponents(code).find((x) => x.name === 'Button');
    expect(button?.props).toMatchObject({ onClick: null, value: null, id: null });
    for (const prop of ['onClick', 'value', 'id']) expect(JSON.stringify(code)).toContain(`expression:${prop}`);
  });

  it('lifts a published heading anchor out of the div that carries it', () => {
    const doc = markdownToIr('<div id="openapi-overlays">\n  ## OpenAPI Overlays\n</div>\n', { platform: 'mintlify', file: 'a.mdx', pageId: 'p' });
    const w = mkdtempSync(join(tmpdir(), 'dai-anchor-')); ensureWorkspace(w);
    const engine = new RulesEngine({ platform: 'mintlify', mappings: loadMappings([join(repoRoot, 'skills/migrate-mintlify/mappings/mintlify.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
    const out = engine.resolveDoc(doc);
    rmSync(w, { recursive: true, force: true });
    const headings: any[] = [];
    walkBlocks(out.children, (n: any) => { if (n.type === 'heading') headings.push(n); });
    expect(headings).toHaveLength(1);
    // the anchor lands in the same field the authored {#custom-id} form lifts into
    expect((headings[0] as any).sourceId).toBe('openapi-overlays');
    // and the wrapper itself does not reach the output
    expect(JSON.stringify(out.children)).not.toContain('"name":"div"');
  });

  it('converts Document360 snippet tokens to non-executable references', () => {
    const doc = markdownToIr('Before\n\n{{snippet.Shared plan}}\n', { platform: 'document360', file: 'a.md', pageId: 'p' });
    expect(doc.children.some((x) => x.type === 'snippetRef' && x.token === 'Shared plan')).toBe(true);
  });
});

describe('Rules engine', () => {
  it('converts the fixture to contract-valid MDX with a complete ledger', () => {
    const doc = buildDoc();
    const ledger = new Ledger(ws);
    const log = new DecisionLog(ws);
    const mappings = loadMappings([
      join(repoRoot, 'skills/migrate-document360/mappings/document360.yaml'),
      join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml'),
    ]);
    const engine = new RulesEngine({ platform: 'document360', mappings, ledger, log });
    const resolved = engine.resolveDoc(doc);
    const mdx = docToMdx(resolved, { quarantinePlaceholder: (r) => `{/* QUARANTINED: ${r} */}` });

    expect(mdx).toContain('<Callout kind="info">');
    expect(mdx).toContain('<Callout kind="alert">');
    expect(mdx).toContain('<Expandable title="Why do I need this?">');
    expect(mdx).toContain('<ExpandableGroup>');
    expect(mdx).toContain('<Iframe src="https://www.youtube.com/embed/abc123" title="Intro" />');
    expect(mdx).toContain('QUARANTINED: embed host "evil.example.com" not allowlisted');
    expect(mdx).not.toContain('<script');
    expect(mdx).not.toContain('onclick');
    expect(mdx).not.toContain('position');
    expect(mdx).toContain('| Plan | Limit |');
    expect(mdx).toContain('```bash');
    expect(mdx).toContain('UNRESOLVED SNIPPET All Plans');

    // contract: only the unresolved snippet placeholder is an MDX comment; everything else must validate
    const issues = validateMdx(mdx).filter((i: { code: string }) => i.code !== 'expression');
    expect(issues).toEqual([]);

    // ledger: every source node has a disposition
    const ids: Array<{ pageId: string; nodeId: string }> = [];
    walkBlocks(doc.children, (n) => { ids.push({ pageId: doc.pageId, nodeId: n.id }); });
    const summary = summarize(Ledger.read(ws), ids);
    expect(summary.missing).toEqual([]);
    expect(summary.quarantined).toBeGreaterThanOrEqual(1);
    expect(summary.transformed).toBeGreaterThanOrEqual(6);
  });

  it('is deterministic: same input, same bytes', () => {
    const run = () => {
      const w = mkdtempSync(join(tmpdir(), 'dai-det-')); ensureWorkspace(w);
      const engine = new RulesEngine({ platform: 'document360', mappings: loadMappings([join(repoRoot, 'skills/migrate-document360/mappings/document360.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
      const out = docToMdx(engine.resolveDoc(buildDoc()));
      rmSync(w, { recursive: true, force: true });
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('Safe MDX serialization', () => {
  it('chooses fences that cannot be closed by inline or block code content', () => {
    expect(inlineToMdx([{ id: 'i', type: 'inlineCode', value: 'a``b' }])).toBe('```a``b```');
    const mdx = blocksToMdx([{ id: 'c', type: 'code', lang: 'ts', value: 'const ticks = ```;' }]);
    expect(mdx).toBe('````ts\nconst ticks = ```;\n````');
  });

  it('serializes hostile-looking frontmatter as valid YAML data', () => {
    const title = 'Guide\n---\ninjected: true';
    const yaml = frontmatterToYaml({ title, jsonLd: { '@type': 'TechArticle', headline: 'A: B' } });
    const match = yaml.match(/^---\n([\s\S]*)\n---\n$/);
    expect(match).not.toBeNull();
    const parsed = parseYaml(match![1]);
    expect(parsed.title).toBe(title);
    expect(parsed.injected).toBeUndefined();
    expect(parsed.jsonLd).toEqual({ '@type': 'TechArticle', headline: 'A: B' });
  });

  it('strips executable URLs while preserving visible labels', () => {
    const link = inlineToMdx([{ id: 'l', type: 'link', url: 'java\nscript:alert(1)', children: [{ id: 't', type: 'text', value: 'Read me' }] }]);
    const image = blocksToMdx([{ id: 'i', type: 'image', url: 'data:text/html,<script>alert(1)</script>', alt: 'Diagram' }]);
    expect(link).toBe('Read me');
    expect(image).toBe('Diagram');
    expect(`${link}${image}`).not.toMatch(/javascript:|data:text\/html/i);
  });
});

describe('Signatures', () => {
  it('clusters by platform, name, prop buckets and topology', () => {
    const doc = buildDoc();
    const comps = collectComponents(doc).map((node) => ({ pageId: doc.pageId, node, depth: 0 }));
    const clusters = clusterComponents(comps);
    const byName = Object.fromEntries(clusters.map((c) => [c.signature.name, c]));
    expect(byName.details).toBeDefined();
    expect(byName.details.signature.props.summary).toBe('string:short');
    expect(clusters.every((c) => c.cluster.startsWith('document360/'))).toBe(true);
  });
});

describe('Contract validator', () => {
  it('rejects editor-only nodes, unknown components, invalid kinds and expressions', () => {
    const bad = `---\ntitle: X\n---\n<htmlBlock>x</htmlBlock>\n<CardGroup cols={2}></CardGroup>\n<Callout kind="note">y</Callout>\n{foo.bar}\n:::note\n`;
    const codes = validateMdx(bad).map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['editor-only-node', 'unknown-component', 'invalid-prop-value', 'expression', 'residual-source-syntax']));
  });
  it('accepts the supported user expression and numeric props', () => {
    const ok = `---\ntitle: X\n---\nHello {user.firstname}\n<Columns cols={3}>\n<Card title="A">a</Card>\n</Columns>\n`;
    expect(validateMdx(ok)).toEqual([]);
  });
});
