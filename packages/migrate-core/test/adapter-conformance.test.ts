/**
 * One suite every native adapter must pass.
 *
 * Each platform used to be tested on its own terms, so a guarantee could hold for Mintlify and
 * quietly not hold for GitBook: the same migration promise was being kept to different standards.
 * These are the properties a stage relies on whatever the source is — a page identity that does
 * not move, a title the source stated, navigation that places only pages that exist, and the same
 * answer when the same bytes are read twice.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NATIVE_ADAPTERS, adapterFor, type NativeSourceAdapter } from '../src/adapters/registry.js';
import { placedPageIds, type SourceNavigationNode } from '../src/nav/tree.js';

const write = (root: string, file: string, body: string): void => {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), body);
};

/** A minimal but real repository for each platform: what that platform actually writes. */
const FIXTURES: Record<string, (root: string) => void> = {
  mintlify: (root) => {
    write(root, 'docs.json', JSON.stringify({
      name: 'Acme docs',
      navigation: { groups: [{ group: 'Guides', pages: ['guides/install', 'guides/configure'] }] },
    }));
    write(root, 'guides/install.mdx', '---\ntitle: Install the CLI\ndescription: How to install\n---\n\nRun the installer.\n');
    write(root, 'guides/configure.mdx', '---\ntitle: Configure it\n---\n\nEdit the config file.\n');
  },
  gitbook: (root) => {
    write(root, 'SUMMARY.md', '# Table of contents\n\n* [Welcome](README.md)\n\n## Guides\n\n* [Install](guides/install.md)\n');
    write(root, 'README.md', '# Welcome\n\nStart here.\n');
    write(root, 'guides/install.md', '# Install\n\nRun the installer.\n');
  },
  fern: (root) => {
    write(root, 'fern/fern.config.json', JSON.stringify({ organization: 'acme', version: '0.45.0' }));
    write(root, 'fern/docs.yml', [
      'instances:',
      '  - url: acme.docs.buildwithfern.com',
      'navigation:',
      '  - page: Welcome',
      '    path: ./pages/welcome.mdx',
      '  - section: Guides',
      '    contents:',
      '      - page: Install the CLI',
      '        path: ./pages/guides/install.mdx',
      '',
    ].join('\n'));
    write(root, 'fern/pages/welcome.mdx', '---\ntitle: Welcome\n---\n\nStart here.\n');
    write(root, 'fern/pages/guides/install.mdx', '---\ntitle: Install the CLI\ndescription: How to install\n---\n\nRun the installer.\n');
  },
  docusaurus: (root) => {
    // no sidebars.* on purpose: this site's navigation is the docs tree plus _category_ and front matter
    write(root, 'package.json', JSON.stringify({ name: 'fixture', dependencies: { '@docusaurus/core': '3.10.2' } }));
    write(root, 'docusaurus.config.ts', "export default { title: 'Fixture' };\n");
    write(root, 'docs/intro.md', '---\ntitle: Introduction\nsidebar_label: Intro\nsidebar_position: 1\n---\n\nWelcome.\n');
    write(root, 'docs/guides/_category_.json', JSON.stringify({ label: 'Guides', position: 2 }));
    write(root, 'docs/guides/install.md', '---\nsidebar_position: 1\n---\n\n# Install the CLI\n\nRun the installer.\n');
  },
  nextra: (root) => {
    write(root, 'package.json', JSON.stringify({ name: 'fixture', dependencies: { nextra: '4.0.0', 'nextra-theme-docs': '4.0.0' } }));
    write(root, 'next.config.mjs', "import nextra from 'nextra';\nexport default nextra({})({});\n");
    // the sidebar lives in these modules, which the adapter records and does not read
    write(root, 'content/_meta.js', "export default { index: 'Welcome', guides: 'Guides' };\n");
    write(root, 'content/index.mdx', '---\ntitle: Welcome\n---\n\nStart here.\n');
    write(root, 'content/guides/_meta.js', "export default { install: 'Install the CLI' };\n");
    write(root, 'content/guides/install.mdx', '# Install the CLI\n\nRun the installer.\n');
  },
  madcap: (root) => {
    const bom = '\uFEFF';
    write(root, 'AcmeDocs.flprj', `${bom}<?xml version="1.0" encoding="utf-8"?>\n<CatapultProject Version="1" MasterToc="/Project/TOCs/Primary.fltoc" />\n`);
    write(root, 'Project/TOCs/Primary.fltoc', `${bom}<?xml version="1.0" encoding="utf-8"?>
<CatapultToc Version="1">
  <TocEntry Title="Getting Started" Link="/Content/GettingStarted.htm" />
  <TocEntry Title="Reference">
    <TocEntry Title="[%=System.LinkedTitle%]" Link="/Content/Reference/ApiKeys.htm" />
  </TocEntry>
</CatapultToc>
`);
    write(root, 'Project/Targets/Online.fltar', `${bom}<?xml version="1.0" encoding="utf-8"?>\n<CatapultTarget Version="1" Type="WebHelp2" MasterToc="/Project/TOCs/Primary.fltoc" ConditionTagExpression="include[Primary.Online] exclude[Primary.Internal] " />\n`);
    write(root, 'Content/GettingStarted.htm', `${bom}<?xml version="1.0" encoding="utf-8"?>\n<html xmlns:MadCap="http://www.madcapsoftware.com/Schemas/MadCap.xsd"><head><title>Getting Started</title></head><body><h1>Getting Started</h1><p>Welcome.</p></body></html>\n`);
    // no <title>: the linked title resolves through the first heading, which is what Flare does
    write(root, 'Content/Reference/ApiKeys.htm', `${bom}<?xml version="1.0" encoding="utf-8"?>\n<html xmlns:MadCap="http://www.madcapsoftware.com/Schemas/MadCap.xsd"><head><title></title></head><body><h1>About API Keys</h1><p>Keys.</p></body></html>\n`);
  },
  readme: (root) => {
    write(root, 'docs/install.md', '---\ntitle: Install the CLI\nslug: install\nexcerpt: How to install\ncategory: Guides\n---\n\nRun the installer.\n');
    write(root, 'docs/configure.md', '---\ntitle: Configure it\nslug: configure\ncategory: Guides\n---\n\nEdit the config file.\n');
  },
};

const build = (adapter: NativeSourceAdapter): string => {
  const root = mkdtempSync(join(tmpdir(), `dai-${adapter.platform}-`));
  const fixture = FIXTURES[adapter.platform];
  if (!fixture) throw new Error(`no conformance fixture for the ${adapter.platform} adapter; every registered adapter needs one`);
  fixture(root);
  return root;
};

describe('every registered native adapter', () => {
  it('is covered by this suite', () => {
    expect(NATIVE_ADAPTERS.map((adapter) => adapter.platform).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  describe.each(NATIVE_ADAPTERS.map((adapter) => [adapter.platform, adapter] as const))('%s', (platform, adapter) => {
    it('recognises its own repository and not another platform\'s', () => {
      expect(adapter.detect(build(adapter))).toBe(true);
      for (const other of NATIVE_ADAPTERS) {
        if (other.platform === platform) continue;
        // detection reads what the platform itself writes, so another platform's repository is not claimed
        expect(adapter.detect(build(other))).toBe(false);
      }
    });

    it('is chosen for its own repository, and an operator naming a platform overrides detection', () => {
      const root = build(adapter);
      expect(adapterFor(root)?.platform).toBe(platform);
      expect(adapterFor(root, platform)?.platform).toBe(platform);
      expect(adapterFor(root, 'not-a-platform')).toBeUndefined();
    });

    it('reads pages that carry the title the source states, a source path and a stable identity', () => {
      const { tree, meta, summary } = adapter.read(build(adapter));
      expect(tree.pages.length).toBeGreaterThan(0);
      expect(meta.platform).toBe(platform);
      expect(summary).toContain(String(tree.pages.length));
      for (const page of tree.pages) {
        expect(page.id, 'every page needs an identity').toBeTruthy();
        expect(page.title.trim(), `${page.source} has no title`).not.toBe('');
        expect(page.source, 'a page source is relative to the frozen root').not.toMatch(/^\//);
        expect(page.order, 'order places the page in the source sequence').toBeTypeOf('number');
      }
      expect(new Set(tree.pages.map((page) => page.id)).size, 'page identities are unique').toBe(tree.pages.length);
    });

    it('reads the same repository the same way twice', () => {
      const root = build(adapter);
      expect(JSON.stringify(adapter.read(root))).toBe(JSON.stringify(adapter.read(root)));
    });

    it('gives a page the same identity wherever the repository is checked out', () => {
      const [first, second] = [build(adapter), build(adapter)];
      const ids = (root: string): string[] => adapter.read(root).tree.pages.map((page) => page.id).sort();
      // identity follows the page, not the directory the repository happens to sit in
      expect(ids(first)).toEqual(ids(second));
    });

    it('states navigation that places only pages it read, and matches the witness verification re-reads', () => {
      const root = build(adapter);
      const { tree } = adapter.read(root);
      const witness = adapter.navigationWitness(root);
      expect(witness ?? undefined).toEqual(tree.navigation ?? undefined);
      if (!tree.navigation?.length) return;
      expect(tree.navigationSource, 'declared navigation is a statement by the source').toBe('source-config');
      const known = new Set(tree.pages.map((page) => page.id));
      const placed = placedPageIds(tree.navigation as SourceNavigationNode[]);
      for (const id of placed) expect(known.has(id), 'navigation places a page the adapter did not read').toBe(true);
      const unplaced = tree.pages.filter((page) => page.migrate && !placed.has(page.id));
      expect(unplaced.map((page) => page.source), 'every migrated page has a placement').toEqual([]);
    });
  });
});
