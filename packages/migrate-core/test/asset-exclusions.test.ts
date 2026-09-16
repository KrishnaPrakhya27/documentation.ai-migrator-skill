import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyAssetExclusions,
  excludedAssets,
  unhostedAssets,
  dropExcludedAssets,
  type AssetManifest,
} from '../src/assets/manifest.js';
import { assertAssetsHosted, runAssetsStage } from '../src/assets/stage.js';
import { readManifest } from '../src/assets/manifest.js';
import { readScopeDecisions, ensureScopeDecisionsFile } from '../src/evidence/scope.js';
import type { DocIR } from '../src/ir/types.js';

const BIG = 'https://2672413337-files.gitbook.io/~/files/v0/o/light-dark-toggle.gif';
const OK = 'https://2672413337-files.gitbook.io/~/files/v0/o/kept.png';

const manifest = (): AssetManifest => ({
  provider: 's3',
  byUrl: { [BIG]: 'h-big', [OK]: 'h-ok' },
  entries: {
    'h-big': { hash: 'h-big', sourceUrls: [BIG], references: [], status: 'failed', error: 'response too large (62350486 bytes)', altMissing: 0 },
    'h-ok': { hash: 'h-ok', sourceUrls: [OK], references: [], status: 'ingested', finalUrl: 'https://cdn.example.com/h-ok.png', altMissing: 0 },
  },
});

const DECISION = [{ url: BIG, reason: 'exceeds the fetch cap', approvedBy: 'A Person', approvedAt: '2026-09-16' }];

const workspace = (): string => {
  const ws = mkdtempSync(join(tmpdir(), 'asset-excl-'));
  mkdirSync(join(ws, 'plan'), { recursive: true });
  return ws;
};

describe('approved asset exclusions', () => {
  it('matches a decision keyed by content hash, so a signed URL never enters a plan file', () => {
    const m = manifest();
    applyAssetExclusions(m, [{ hash: 'h-big', reason: 'exceeds the fetch cap', approvedBy: 'A Person' }]);
    expect(excludedAssets(m).map((e) => e.hash)).toEqual(['h-big']);
    expect(unhostedAssets(m)).toEqual([]);
  });

  it('lets an approved asset past the exact gate and leaves every other one blocking', () => {
    const m = manifest();
    expect(() => assertAssetsHosted(m, 'assets')).toThrow(/1 of them has none/);
    applyAssetExclusions(m, DECISION);
    expect(() => assertAssetsHosted(m, 'assets')).not.toThrow();
    expect(unhostedAssets(m)).toEqual([]);
    expect(excludedAssets(m).map((e) => e.sourceUrls[0])).toEqual([BIG]);
  });

  it('matches a token-free URL against a signed address, keeping the credential out of the plan file', () => {
    const signed = 'https://2672413337-files.gitbook.io/~/files/v0/o/New%20Share%20Modal.gif?alt=media&token=f392f982-24a9';
    const m: AssetManifest = {
      provider: 's3', byUrl: { [signed]: signed },
      entries: { [signed]: { hash: signed, sourceUrls: [signed], references: [], status: 'failed', error: 'response too large', altMissing: 0 } },
    };
    applyAssetExclusions(m, [{ url: 'https://2672413337-files.gitbook.io/~/files/v0/o/New%20Share%20Modal.gif', reason: 'too large', approvedBy: 'P' }]);
    expect(excludedAssets(m)).toHaveLength(1);
    expect(unhostedAssets(m)).toEqual([]);
  });

  it('does not let a token-free URL match a different file on the same host', () => {
    const signed = 'https://h/~/files/v0/o/a.gif?token=x';
    const m: AssetManifest = {
      provider: 's3', byUrl: { [signed]: signed },
      entries: { [signed]: { hash: signed, sourceUrls: [signed], references: [], status: 'failed', altMissing: 0 } },
    };
    expect(() => applyAssetExclusions(m, [{ url: 'https://h/~/files/v0/o/b.gif', reason: 'r', approvedBy: 'P' }]))
      .toThrow(/not an asset of this migration/);
  });

  it('refuses a decision that names no asset of this migration, rather than silently protecting nothing', () => {
    const m = manifest();
    expect(() => applyAssetExclusions(m, [{ reason: 'r', approvedBy: 'P', url: 'https://example.com/typo.gif' }]))
      .toThrow(/not an asset of this migration/);
  });

  it('removes the reference instead of leaving it pointing at the source host', () => {
    const m = manifest();
    applyAssetExclusions(m, DECISION);
    const doc: DocIR = {
      pageId: 'p', platform: 'gitbook', source: 'https://gitbook.com/docs/changelog/2023-product-updates',
      frontmatter: { title: 'T' },
      children: [
        { id: '1', type: 'paragraph', children: [{ id: '1a', type: 'text', value: 'Before' }] },
        { id: '2', type: 'image', url: BIG, alt: 'toggle' },
        { id: '3', type: 'figure', image: { id: '3a', type: 'image', url: BIG, alt: 'toggle' } },
        { id: '4', type: 'image', url: OK, alt: 'kept' },
        { id: '5', type: 'paragraph', children: [{ id: '5a', type: 'text', value: 'After' }] },
      ] as any,
    } as DocIR;
    const out = dropExcludedAssets(doc, m);
    const json = JSON.stringify(out.children);
    expect(json).not.toContain('light-dark-toggle.gif');
    expect(json).toContain('kept.png');
    // the words around it are untouched
    expect(json).toContain('Before');
    expect(json).toContain('After');
    expect((out.children as any[]).map((b) => b.id)).toEqual(['1', '4', '5']);
  });

  it('drops an excluded image nested inside a list or a component', () => {
    const m = manifest();
    applyAssetExclusions(m, DECISION);
    const doc: DocIR = {
      pageId: 'p', platform: 'gitbook', source: 'https://gitbook.com/docs/x', frontmatter: { title: 'T' },
      children: [
        { id: 'l', type: 'list', ordered: false, children: [{ id: 'li', type: 'listItem', children: [{ id: 'i', type: 'image', url: BIG, alt: '' }] }] },
        { id: 'c', type: 'component', name: 'Card', props: {}, children: [{ id: 'ci', type: 'image', url: BIG, alt: '' }] },
      ] as any,
    } as DocIR;
    expect(JSON.stringify(dropExcludedAssets(doc, m).children)).not.toContain('light-dark-toggle.gif');
  });

  it('persists the decision, so convert and verify — which read plan/assets.json — see the asset as decided', async () => {
    const ws = workspace();
    const doc = {
      pageId: 'p', platform: 'gitbook', source: 'https://gitbook.com/docs/changelog/2023-product-updates',
      frontmatter: { title: 'T' }, children: [{ id: 'i', type: 'image', url: BIG, alt: 'toggle' }],
    } as unknown as DocIR;
    // no fetcher: the asset cannot be hosted, which exact mode refuses unless a person decided it
    await expect(runAssetsStage({ workspace: ws, docs: [doc], fidelityMode: 'exact', provider: { workspace: ws, provider: 'none' } })).rejects.toThrow(/1 of them has none/);
    const result = await runAssetsStage({ workspace: ws, docs: [doc], fidelityMode: 'exact', provider: { workspace: ws, provider: 'none' }, excluded: DECISION });
    expect(result.unhosted).toEqual([]);
    const onDisk = readManifest(ws);
    expect(excludedAssets(onDisk).map((entry) => entry.sourceUrls[0])).toEqual([BIG]);
    expect(unhostedAssets(onDisk)).toEqual([]);
  });

  it('reads the decisions from plan/scope-decisions.yaml and validates them', () => {
    const ws = workspace();
    ensureScopeDecisionsFile(ws);
    expect(readScopeDecisions(ws).assets).toEqual([]);

    writeFileSync(join(ws, 'plan', 'scope-decisions.yaml'),
      `excluded: []\nsubstituted: []\nhelpSystems: []\nassets:\n  - url: ${BIG}\n    reason: exceeds the fetch cap\n    approvedBy: A Person\n    approvedAt: '2026-09-16'\n`);
    expect(readScopeDecisions(ws).assets).toEqual([{ url: BIG, reason: 'exceeds the fetch cap', approvedBy: 'A Person', approvedAt: '2026-09-16' }]);

    // a signed URL is a credential: the hash keys the decision instead, and never reaches the file
    writeFileSync(join(ws, 'plan', 'scope-decisions.yaml'),
      `excluded: []\nsubstituted: []\nhelpSystems: []\nassets:\n  - hash: h-big\n    describe: the light/dark toggle GIF\n    reason: exceeds the fetch cap\n    approvedBy: A Person\n`);
    expect(readScopeDecisions(ws).assets).toEqual([{ hash: 'h-big', describe: 'the light/dark toggle GIF', reason: 'exceeds the fetch cap', approvedBy: 'A Person' }]);

    writeFileSync(join(ws, 'plan', 'scope-decisions.yaml'),
      `excluded: []\nsubstituted: []\nhelpSystems: []\nassets:\n  - reason: names nothing\n    approvedBy: P\n`);
    expect(() => readScopeDecisions(ws)).toThrow(/needs a hash or a url/);

    writeFileSync(join(ws, 'plan', 'scope-decisions.yaml'),
      `excluded: []\nsubstituted: []\nhelpSystems: []\nassets:\n  - url: ${BIG}\n    reason: no approver\n`);
    expect(() => readScopeDecisions(ws)).toThrow(/approvedBy is required/);

    writeFileSync(join(ws, 'plan', 'scope-decisions.yaml'),
      `excluded: []\nsubstituted: []\nhelpSystems: []\nassets:\n  - url: ${BIG}\n    reason: a\n    approvedBy: P\n  - url: ${BIG}\n    reason: b\n    approvedBy: P\n`);
    expect(() => readScopeDecisions(ws)).toThrow(/repeats url/);
  });
});
