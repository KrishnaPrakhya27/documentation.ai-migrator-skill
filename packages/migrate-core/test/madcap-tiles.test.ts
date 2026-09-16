import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToIr } from '../src/ir/from-html.js';
import { PROFILES, htmlAdapterOptions } from '../src/scrape/profiles.js';
import { RulesEngine, loadMappings, applyDeclaredLosses } from '../src/components/rules-engine.js';
import { Ledger } from '../src/ledger/dispositions.js';
import { DecisionLog } from '../src/log/decisions.js';
import { ensureWorkspace } from '../src/session/workspace.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import { retargetDocLinks, siteLinkTarget, type SiteLinks } from '../src/urls/site-links.js';
import { authoredContentSnapshot, fidelityEqual } from '../src/verify/fidelity.js';
import type { DocIR } from '../src/ir/types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('MadCap landing-page tiles', () => {
  it('become a four-column grid of cards, one per tile, with the tile’s label and target', () => {
    const html = '<div id="mc-main-content"><h3>Procedural Guides</h3><p>Get step-by-step instructions.</p><div class="procedure-tiles"><a href="Procedures/Account Management/p_account_LP.htm" class="procedure-button">Account Management</a><a href="Procedures/Admin/p_admin_LP.htm" class="procedure-button">Admin and Rights</a></div></div>';
    const ir = htmlToIr(html, htmlAdapterOptions(PROFILES.madcap, { platform: 'madcap', file: 'https://learn.example.com/home.htm' }));
    const doc: DocIR = { pageId: 'p', platform: 'madcap', source: 'https://learn.example.com/home.htm', frontmatter: { title: 'Home' }, children: ir.children };
    const w = mkdtempSync(join(tmpdir(), 'dai-tiles-')); ensureWorkspace(w);
    const engine = new RulesEngine({ platform: 'madcap', mappings: loadMappings([join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
    const mdx = docToMdx(engine.resolveDoc(doc));
    expect(mdx).toContain('<Columns cols={4}>');
    expect(mdx).toContain('<Card title="Account Management" href="Procedures/Account Management/p_account_LP.htm" />');
    expect(mdx).toContain('<Card title="Admin and Rights" href="Procedures/Admin/p_admin_LP.htm" />');
    expect(mdx).not.toContain('[Account Management](');
    expect(mdx).toContain('### Procedural Guides');
  });
});

describe('MadCap landing tabs and tile menus', () => {
  const toc = 'https://learn.example.com/Data/Tocs/campaigns_ref_toc.js';
  const data = new Map<string, string>([
    [toc, "define({numchunks:1,prefix:'campaigns_ref_toc_Chunk',tree:{n:[{i:0,c:0},{i:1,c:0,n:[{i:2,c:0}]}]}})"],
    ['https://learn.example.com/Data/Tocs/campaigns_ref_toc_Chunk0.js', "define({'/Reference/Campaigns/behaviors.htm':{i:[0],t:['Campaign behaviors'],b:['']},'/Reference/Campaigns/types.htm':{i:[1],t:['Campaign types'],b:['']},'/Reference/Campaigns/types.htm#a':{i:[2],t:['Type A'],b:['']}})"],
  ]);
  const html = '<html data-mc-path-to-help-system="../"><body><div id="mc-main-content"><div class="tab-wrapper five"><span class="mobile-content tab-item current"><img src="R.png" class="tab-image" />Reference</span><div class="mobile-dropdown"><div class="tab-item"><a href="Strategies.htm"><img src="S.gif" class="tab-image" />Strategies</a></div><div class="tab-item current"><a href="#" class="selected"><img src="R.png" class="tab-image" />Reference</a></div></div></div><div class="feature-tiles"><div class="tile-body"><div class="tile-content"><h4>Campaign Behaviors</h4><ul class="nocontent menu mc-component" data-mc-linked-toc="Data/Tocs/campaigns_ref_toc.js" data-mc-max-depth="1"></ul></div></div></div></div></body></html>';
  const convert = (flareData?: Map<string, string>) => {
    const source = 'https://learn.example.com/Reference/Reference.htm';
    const ir = htmlToIr(html, htmlAdapterOptions(PROFILES.madcap, { platform: 'madcap', file: source }));
    for (const b of ir.children) if (b.type === 'component' && b.name === 'MCLinkedToc') { b.props.tocUrl = toc; b.props.helpRoot = 'https://learn.example.com/'; }
    const doc: DocIR = { pageId: 'p', platform: 'madcap', source, frontmatter: { title: 'Reference' }, children: ir.children };
    const w = mkdtempSync(join(tmpdir(), 'dai-toc-')); ensureWorkspace(w);
    const engine = new RulesEngine({ platform: 'madcap', mappings: loadMappings([join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w), flareData });
    return docToMdx(engine.resolveDoc(doc));
  };
  it('writes the tab strip as cards, the current tab without a link and its mobile duplicate dropped', () => {
    const mdx = convert(data);
    expect(mdx).toContain('<Card title="Strategies" href="Strategies.htm" />');
    expect(mdx).toContain('<Card title="Reference" />');
    expect(mdx.match(/title="Reference"/g)).toHaveLength(1);
  });
  it('writes a tile menu as the list of links its table of contents names, one level deep', () => {
    const mdx = convert(data);
    expect(mdx).toContain('#### Campaign Behaviors');
    expect(mdx).toContain('- [Campaign behaviors](https://learn.example.com/Reference/Campaigns/behaviors.htm)');
    expect(mdx).toContain('- [Campaign types](https://learn.example.com/Reference/Campaigns/types.htm)');
    expect(mdx).not.toContain('Type A');
  });
  it('holds the page when the table of contents was not captured', () => {
    expect(convert(new Map())).toContain('QUARANTINED: linked table of contents');
  });
});

describe('a tile menu’s links are links between pages', () => {
  const toc = 'https://learn.example.com/Data/Tocs/release_notes_toc.js';
  const data = new Map<string, string>([
    [toc, "define({numchunks:1,prefix:'release_notes_toc_Chunk',tree:{n:[{i:0,c:0},{i:1,c:0}]}})"],
    ['https://learn.example.com/Data/Tocs/release_notes_toc_Chunk0.js', "define({'/ReleaseNotes/release-2024-4.htm':{i:[0],t:['July 2024 Release Notes'],b:['']},'/ReleaseNotes/gone.htm':{i:[1],t:['Retired notes'],b:['']}})"],
  ]);
  const links: SiteLinks = {
    routes: { '/ReleaseNotes/release-2024-4.htm': 'ReleaseNotes/release-2024-4' },
    sourceBases: { 'https://learn.example.com/ReleaseNotes/release-notes.htm': '/ReleaseNotes/release-notes.htm' },
    sourcePages: ['/ReleaseNotes/release-2024-4.htm'],
    hosts: ['learn.example.com'],
    origin: 'https://learn.example.com',
    unmigrated: 'keep',
  };
  const build = () => {
    const source = 'https://learn.example.com/ReleaseNotes/release-notes.htm';
    const html = '<html data-mc-path-to-help-system="../"><body><div id="mc-main-content"><ul class="nocontent menu mc-component" data-mc-linked-toc="Data/Tocs/release_notes_toc.js" data-mc-max-depth="1"></ul></div></body></html>';
    const ir = htmlToIr(html, htmlAdapterOptions(PROFILES.madcap, { platform: 'madcap', file: source }));
    for (const b of ir.children) if (b.type === 'component' && b.name === 'MCLinkedToc') { b.props.tocUrl = toc; b.props.helpRoot = 'https://learn.example.com/'; }
    const doc: DocIR = { pageId: 'p', platform: 'madcap', source, frontmatter: { title: 'Release Notes' }, children: ir.children };
    const w = mkdtempSync(join(tmpdir(), 'dai-toclinks-')); ensureWorkspace(w);
    const engine = new RulesEngine({ platform: 'madcap', mappings: loadMappings([join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w), flareData: data });
    const target = siteLinkTarget(links);
    // the convert pipeline: retarget, resolve, retarget again
    return { engine, doc, resolved: retargetDocLinks(engine.resolveDoc(retargetDocLinks(doc, target)), target) };
  };

  it('sends a drawn link to the route that page migrated to, not back to the source site', () => {
    const mdx = docToMdx(build().resolved);
    expect(mdx).toContain('[July 2024 Release Notes](/ReleaseNotes/release-2024-4)');
    expect(mdx).not.toContain('https://learn.example.com/ReleaseNotes/release-2024-4.htm');
  });

  it('leaves a drawn link the migration does not write where the source pointed it', () => {
    expect(docToMdx(build().resolved)).toContain('[Retired notes](https://learn.example.com/ReleaseNotes/gone.htm)');
  });

  it('reads the source side of the exactness comparison the same way once the menu is a recorded substitution', () => {
    const { engine, doc, resolved } = build();
    const target = siteLinkTarget(links);
    const prepared = retargetDocLinks(applyDeclaredLosses(retargetDocLinks(doc, target), engine, new Set(['MCLinkedToc'])), target);
    expect(fidelityEqual(authoredContentSnapshot(prepared), authoredContentSnapshot(resolved))).toBe(true);
  });

  it('still fails the comparison when no one recorded that substitution', () => {
    const { engine, doc, resolved } = build();
    const target = siteLinkTarget(links);
    const prepared = retargetDocLinks(applyDeclaredLosses(retargetDocLinks(doc, target), engine), target);
    expect(fidelityEqual(authoredContentSnapshot(prepared), authoredContentSnapshot(resolved))).toBe(false);
  });
});
