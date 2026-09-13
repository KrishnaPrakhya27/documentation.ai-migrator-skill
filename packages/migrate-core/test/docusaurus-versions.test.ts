/**
 * A versioned or translated Docusaurus site keeps each released version beside the current one and
 * each locale under i18n/. Reading only docs/ would migrate one version of a site that publishes
 * several, and would report the others as pages that do not exist.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readDocusaurusRepo } from '../src/adapters/docusaurus.js';
import { buildNavigation } from '../src/nav/tree.js';
import { applyUrlPlan, defaultUrlPlan } from '../src/urls/plan.js';

const write = (root: string, file: string, body: string): void => {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), body);
};

function site(): string {
  const root = mkdtempSync(join(tmpdir(), 'dai-docusaurus-'));
  write(root, 'docusaurus.config.ts', "export default { title: 'Fixture' };\n");
  write(root, 'docs/intro.md', '---\ntitle: Introduction\n---\n\nCurrent version.\n');
  write(root, 'versions.json', JSON.stringify(['2.0', '1.0']));
  write(root, 'versioned_docs/version-2.0/intro.md', '---\ntitle: Introduction\n---\n\nVersion two.\n');
  write(root, 'versioned_docs/version-1.0/intro.md', '---\ntitle: Introduction\n---\n\nVersion one.\n');
  write(root, 'i18n/fr/docusaurus-plugin-content-docs/current/intro.md', '---\ntitle: Présentation\n---\n\nEn français.\n');
  write(root, 'i18n/fr/docusaurus-plugin-content-docs/version-2.0/intro.md', '---\ntitle: Présentation\n---\n\nVersion deux.\n');
  return root;
}

describe('a versioned and translated Docusaurus site', () => {
  it('reads every version and locale, not only the current English pages', () => {
    const { tree, versions, locales } = readDocusaurusRepo(site());
    expect(versions).toEqual(['2.0', '1.0']);
    expect(locales).toEqual(['fr']);
    expect(tree.pages).toHaveLength(5);
    // newest first in versions.json is the one Docusaurus serves at the base path
    expect(tree.defaultVersion).toBe('2.0');
  });

  it('labels each page with the version and locale it belongs to', () => {
    const { tree } = readDocusaurusRepo(site());
    const placed = tree.pages.map((page) => `${page.locale ?? 'default'}:${page.version ?? 'current'}:${page.source.replace(/\\/g, '/')}`).sort();
    expect(placed).toEqual([
      'en:1.0:versioned_docs/version-1.0/intro.md',
      'en:2.0:versioned_docs/version-2.0/intro.md',
      'en:current:docs/intro.md',
      'fr:2.0:i18n/fr/docusaurus-plugin-content-docs/version-2.0/intro.md',
      'fr:current:i18n/fr/docusaurus-plugin-content-docs/current/intro.md',
    ]);
  });

  it('gives every page its own identity, so one version cannot overwrite another', () => {
    const { tree } = readDocusaurusRepo(site());
    expect(new Set(tree.pages.map((page) => page.id)).size).toBe(tree.pages.length);
  });

  it('gives every published slice a unique route and a navigation placement', () => {
    const { tree } = readDocusaurusRepo(site());
    expect(new Set(tree.pages.map((page) => page.oldPath)).size).toBe(tree.pages.length);
    const planned = applyUrlPlan(tree, defaultUrlPlan(tree));
    const navigation = buildNavigation(planned.pages, { defaultVersion: planned.defaultVersion, defaultLocale: planned.defaultLocale, sourceNavigation: planned.navigation });
    const paths: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'path' && typeof child === 'string') paths.push(child);
        else collect(child);
      }
    };
    collect(navigation);
    expect(new Set(paths).size).toBe(tree.pages.length);
    // Version/locale routing is JS-configurable, so exact mode must wait for a reviewed manual tree.
    expect(tree.navigationSource).toBeUndefined();
  });

  it('leaves a site with no versions and no translations exactly as it was', () => {
    const root = mkdtempSync(join(tmpdir(), 'dai-docusaurus-plain-'));
    write(root, 'docusaurus.config.ts', "export default {};\n");
    write(root, 'docs/intro.md', '---\ntitle: Introduction\n---\n\nOnly page.\n');
    const { tree, versions, locales } = readDocusaurusRepo(root);
    expect([versions, locales]).toEqual([undefined, undefined]);
    expect(tree.defaultVersion).toBeUndefined();
    expect(tree.pages.map((page) => page.version ?? 'current')).toEqual(['current']);
  });
});
