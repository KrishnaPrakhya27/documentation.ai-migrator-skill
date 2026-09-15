/**
 * Hosting an asset changes its URL, in the body and in the social image alike.
 *
 * `source-content-exact` rebuilds the source from the frozen bytes and compares it with the written
 * output. The output carries rehosted asset URLs because that is what the asset stage is for, so a
 * comparison that reads the source's original URLs reports every page as different — which is what
 * happened on a live Mintlify migration: all 14 pages failed at `$.metadata.ogImage` while their
 * content was identical. The source side is put through the same manifest the conversion used.
 *
 * The gate must still be able to fail: an asset the manifest does not know, and a page whose body
 * really did change, both stay failures.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceContentExact, type RawSourcePage } from '../src/verify/source-truth.js';
import type { AssetManifest } from '../src/assets/manifest.js';

const SOURCE_IMAGE = 'https://mintcdn.com/demo/images/diagram.png';
const SOURCE_OG = 'https://demo.mintlify.app/_mintlify/api/og?title=Setup';
const HOSTED_IMAGE = 'https://cdn.example.net/org-o/doc-d/9d077974a7ff6a45.png';
const HOSTED_OG = 'https://cdn.example.net/org-o/doc-d/1bb2c0de4f5a6789.png';

let workspace: string;

/** A manifest that hosted both assets, in the shape `assets` writes. */
function manifest(): AssetManifest {
  return {
    provider: 's3',
    entries: {
      img: { hash: 'img', status: 'ingested', finalUrl: HOSTED_IMAGE, altMissing: 0 } as AssetManifest['entries'][string],
      og: { hash: 'og', status: 'ingested', finalUrl: HOSTED_OG, altMissing: 0 } as AssetManifest['entries'][string],
    },
    byUrl: { [SOURCE_IMAGE]: 'img', [SOURCE_OG]: 'og' },
  };
}

function page(outputMdx: string): RawSourcePage {
  const outputFile = join(workspace, 'setup.mdx');
  writeFileSync(outputFile, outputMdx);
  return {
    pageId: 'p1',
    url: 'https://demo.mintlify.app/setup',
    path: '/setup',
    route: 'setup',
    outputFile,
    title: 'Setup',
    html: `<html><head><meta property="og:image" content="${SOURCE_OG}"/></head><body></body></html>`,
    markdown: `# Setup\n\nInstall it first.\n\n![Diagram](${SOURCE_IMAGE})\n`,
  };
}

/** What convert writes: the source's own statements with every hosted asset pointing at its new home. */
const HOSTED_OUTPUT = `---\ntitle: Setup\nogImage: ${HOSTED_OG}\n---\n\nInstall it first.\n\n![Diagram](${HOSTED_IMAGE})\n`;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'hosted-asset-'));
});

describe('source-content-exact with hosted assets', () => {
  it('passes when the only difference is where the hosted assets are served from', () => {
    const result = sourceContentExact(page(HOSTED_OUTPUT), 'mintlify', undefined, undefined, manifest());
    expect(result.difference).toBeUndefined();
    expect(result.pass).toBe(true);
  });

  it('reports the social image as different when the manifest is not supplied', () => {
    const result = sourceContentExact(page(HOSTED_OUTPUT), 'mintlify', undefined, undefined, undefined);
    expect(result.pass).toBe(false);
    expect(result.difference).toBe('$.metadata.ogImage');
  });

  it('still fails when an asset URL is not the one the manifest hosted', () => {
    const strayImage = HOSTED_OUTPUT.replace(HOSTED_IMAGE, 'https://cdn.example.net/org-o/doc-d/something-else.png');
    const result = sourceContentExact(page(strayImage), 'mintlify', undefined, undefined, manifest());
    expect(result.pass).toBe(false);
    expect(result.difference).toMatch(/blocks/);
  });

  it('still fails when the body text changed, hosted assets notwithstanding', () => {
    const rewritten = HOSTED_OUTPUT.replace('Install it first.', 'Install it later.');
    const result = sourceContentExact(page(rewritten), 'mintlify', undefined, undefined, manifest());
    expect(result.pass).toBe(false);
    expect(result.difference).toMatch(/blocks/);
  });
});
