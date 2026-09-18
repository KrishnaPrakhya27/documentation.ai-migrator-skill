/**
 * A source that has nowhere to state a sidebar icon — a GitBook or Docusaurus sidebar states a link
 * and its text and nothing else — migrated into a sidebar of plain rows, while the same pages
 * written in the editor carry an icon on every one. These cover the proposal that closes that gap:
 * that it reads the entry's own title, that it never overwrites what the source does state, that it
 * writes no name the renderer cannot draw, and that it leaves no container half iconed.
 */
import { describe, it, expect } from 'vitest';
import { loadContract, validateSiteConfig } from '@dai/content-contract';
import { applyIconPolicy, suggestIconName, suggestableIconNames } from '../src/nav/icon-suggest.js';
import { proposeSitePlan, readSitePlan, writeSitePlan } from '../src/nav/site-plan.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGates, type GateInput } from '../src/verify/gates.js';
import { ensureWorkspace } from '../src/session/workspace.js';

const page = (title: string, extra: Record<string, unknown> = {}) => ({ title, path: title.toLowerCase().replace(/\s+/g, '-'), ...extra });

describe('an icon proposed from what an entry calls itself', () => {
  it('reads the phrase before the word, so "getting started" is not "start"', () => {
    expect(suggestIconName('Getting Started', 'group')).toBe('rocket');
    expect(suggestIconName('Quickstart', 'page')).toBe('zap');
    expect(suggestIconName('API Reference', 'tab')).toBe('code');
    expect(suggestIconName('Help Center', 'tab')).toBe('circle-help');
  });

  it('reads a changelog year, which no word list can', () => {
    expect(suggestIconName('2026', 'group')).toBe('calendar');
    expect(suggestIconName('2025', 'group')).toBe('calendar');
    expect(suggestIconName('20260', 'group')).not.toBe('calendar');
  });

  it('gives a container a generic marker when its label says nothing, and a page none', () => {
    expect(suggestIconName('Pets', 'group')).toBe('folder');
    expect(suggestIconName('Pets', 'tab')).toBe('book');
    expect(suggestIconName('Fluffy the cat', 'page')).toBeUndefined();
  });

  it('proposes nothing for a label it cannot read at all', () => {
    expect(suggestIconName('', 'group')).toBeUndefined();
    expect(suggestIconName(undefined, 'group')).toBeUndefined();
    expect(suggestIconName('   ', 'page')).toBeUndefined();
  });

  it('writes only names the renderer can draw', () => {
    const drawable = new Set(loadContract().icons.names);
    const undrawable = suggestableIconNames().filter((name) => !drawable.has(name));
    expect(undrawable).toEqual([]);
  });

  it('is deterministic, so a re-run writes the same file', () => {
    const labels = ['Guides', 'Billing', 'Webhooks', 'Troubleshooting', 'Zzzz'];
    const once = labels.map((label) => suggestIconName(label, 'group'));
    const twice = labels.map((label) => suggestIconName(label, 'group'));
    expect(once).toEqual(twice);
  });
});

describe('the policy applied to a built navigation', () => {
  const navigation = {
    tabs: [
      { tab: 'Documentation', groups: [
        { group: 'Getting Started', pages: [page('Quickstart'), page('Your first project')] },
        { group: 'Reference', icon: 'wrench', pages: [page('Configuration'), page('Glossary')] },
      ] },
      { tab: 'Changelog', groups: [{ group: '2026', pages: [page('Xyzzy'), page('Plugh'), page('Frotz')] }] },
    ],
  };

  it('fills a container that states none and leaves one that states its own', () => {
    const out = applyIconPolicy(structuredClone(navigation), 'suggested');
    const tabs = out.navigation.tabs as any[];
    expect(tabs[0].icon).toBe('book');
    expect(tabs[0].groups[0].icon).toBe('rocket');
    expect(tabs[0].groups[1].icon).toBe('wrench');
  });

  it('gives every page in a container an icon, or none of them', () => {
    const out = applyIconPolicy(structuredClone(navigation), 'suggested');
    const tabs = out.navigation.tabs as any[];
    const started = tabs[0].groups[0].pages as any[];
    expect(started.map((p) => p.icon)).toEqual(['zap', 'file-text']);
    // No title in this group says anything readable, so the rows stay as the source left them
    // rather than carrying a column of the same filler.
    const changelog = tabs[1].groups[0].pages as any[];
    expect(changelog.every((p) => p.icon === undefined)).toBe(true);
  });

  it('does not mix its own choices with a source that iconed the same rows', () => {
    const stated = { groups: [{ group: 'Guides', pages: [page('Quickstart', { icon: 'star' }), page('Billing')] }] };
    const out = applyIconPolicy(stated, 'suggested');
    const pages = (out.navigation.groups as any[])[0].pages as any[];
    expect(pages[0].icon).toBe('star');
    expect(pages[1].icon).toBeUndefined();
  });

  it('leaves the tree alone under source, and strips every icon under none', () => {
    const stated = { groups: [{ group: 'Guides', icon: 'book-open', pages: [page('Quickstart', { icon: 'star' })] }] };
    expect(applyIconPolicy(structuredClone(stated), 'source')).toMatchObject({ navigation: stated, added: 0 });
    const bare = applyIconPolicy(structuredClone(stated), 'none');
    expect(bare.removed).toBe(2);
    expect(JSON.stringify(bare.navigation)).not.toContain('icon');
  });

  it('writes a navigation the platform still accepts', () => {
    const out = applyIconPolicy(structuredClone(navigation), 'suggested');
    expect(validateSiteConfig({ name: 'Docs', navigation: out.navigation })).toEqual([]);
  });

  it('counts what it added, so the stage can say so', () => {
    const out = applyIconPolicy(structuredClone(navigation), 'suggested');
    expect(out.added).toBeGreaterThan(0);
    expect(out.removed).toBe(0);
  });
});

describe('the site plan setting', () => {
  const workspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dai-icons-'));
    mkdirSync(join(dir, 'plan'), { recursive: true });
    return dir;
  };

  it('proposes suggested for a new plan', () => {
    expect(proposeSitePlan(undefined).icons).toBe('suggested');
  });

  it('round-trips through the file', () => {
    const dir = workspace();
    writeSitePlan(dir, { ...proposeSitePlan(undefined), icons: 'none' });
    expect(readSitePlan(dir)!.icons).toBe('none');
  });

  it('reads a plan written before the setting existed as source, so a re-run writes what it wrote before', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'plan', 'site.yaml'), 'branding:\n  carry: true\ntemplate: classic\nstylesheet: true\nredirects: true\n');
    expect(readSitePlan(dir)!.icons).toBe('source');
  });

  it('refuses a value that is not a policy', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'plan', 'site.yaml'), 'branding:\n  carry: true\nicons: shiny\n');
    expect(() => readSitePlan(dir)).toThrow(/icons must be source, suggested, none/);
  });
});

/**
 * `navigation-exact` used to compare the written navigation byte for byte against the reviewed
 * tree, so any proposed icon read as a structural difference and failed the gate. It now compares
 * structure with icons set aside — but only in that direction: an icon the source states must still
 * arrive, unchanged, at the same entry.
 */
describe('the exactness gate with icons in play', () => {
  // The source states an icon on the group and none on its pages, which is what the proposal fills.
  const statedNavigation = { groups: [{ group: 'Guides', icon: 'book-open', pages: [{ title: 'Setup', path: 'guides/setup' }, { title: 'Billing', path: 'guides/billing' }] }] };
  const withGroupIcon = (icon?: string) => ({ groups: [{ group: 'Guides', ...(icon ? { icon } : {}), pages: [{ title: 'Setup', path: 'guides/setup' }, { title: 'Billing', path: 'guides/billing' }] }] });

  const workspaceWith = (navigation: unknown): GateInput => {
    const ws = mkdtempSync(join(tmpdir(), 'dai-icon-gate-'));
    ensureWorkspace(ws);
    const out = join(ws, 'output');
    mkdirSync(join(out, 'guides'), { recursive: true });
    for (const path of ['guides/setup', 'guides/billing']) writeFileSync(join(out, `${path}.mdx`), `---\ntitle: x\n---\n\nBody.\n`);
    writeFileSync(join(out, 'documentation.json'), JSON.stringify({ name: 'Acme Docs', navigation }));
    return {
      workspace: ws, outputDir: out, sourceDocs: [], treePages: [], quarantinedPages: new Set(), excludedPages: new Set(),
      unreviewed: 0, pinnedContractVersion: '0.1.0', fidelityMode: 'exact', navigationSource: 'manual',
      expectedNavigation: statedNavigation,
    };
  };
  const navigationExact = (navigation: unknown) => runGates(workspaceWith(navigation)).find((g) => g.id === 'navigation-exact');

  it('passes when the migration proposed an icon for an entry the source left bare', () => {
    const proposed = applyIconPolicy(structuredClone(statedNavigation), 'suggested').navigation;
    const pages = (proposed as any).groups[0].pages as any[];
    expect(pages.every((p) => typeof p.icon === 'string')).toBe(true);
    expect(navigationExact(proposed)).toMatchObject({ status: 'pass' });
  });

  it('still fails when an icon the source states was dropped', () => {
    expect(navigationExact(withGroupIcon())).toMatchObject({ status: 'fail', count: 1 });
  });

  it('still fails when an icon the source states was changed', () => {
    expect(navigationExact(withGroupIcon('star'))).toMatchObject({ status: 'fail', count: 1 });
  });

  it('still fails on a structural difference, which no icon hides', () => {
    const restructured = { groups: [{ group: 'Guides', icon: 'book-open', pages: [{ title: 'Setup', path: 'guides/setup' }] }] };
    expect(navigationExact(restructured)).toMatchObject({ status: 'fail', count: 1 });
  });
});
