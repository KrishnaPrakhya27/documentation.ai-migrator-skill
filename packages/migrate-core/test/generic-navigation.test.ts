/**
 * A customer site on no known platform still has to migrate with its structure intact.
 * Its sidebar has no shared markup, so the generic profile names the containers in
 * preference order, accepts whatever element labels a group, and reads subpages from
 * the list that follows a page's own link.
 */
import { describe, it, expect } from 'vitest';
import { extractDomSidebarNavigation } from '../src/scrape/discovery.js';
import { getProfile } from '../src/scrape/profiles.js';
import { matchesSelector, parseHtml, findAll } from '../src/ir/from-html.js';

const origin = 'https://docs.example.test';
const url = `${origin}/guides/install`;
const profile = getProfile('generic');

/** A site header full of links, rendered before the sidebar, as most themes do. */
const header = `<nav class="site-header">
  <a href="/">Home</a><a href="/blog">Blog</a><a href="/pricing">Pricing</a><a href="/login">Log in</a>
</nav>`;

const sidebar = `<div class="sidebar">
  <div class="sidebar-group">
    <div class="group-heading">Guides</div>
    <ul>
      <li><a href="/guides/install">Install</a></li>
      <li><a href="/guides/configure">Configure<span class="badge">Beta</span></a>
        <ul>
          <li><a href="/guides/configure/env">Environment</a></li>
          <li><a href="/guides/configure/secrets">Secrets</a></li>
        </ul>
      </li>
    </ul>
  </div>
  <div class="sidebar-group">
    <button class="group-toggle">Reference</button>
    <ul><li><a href="/reference/cli">CLI</a></li></ul>
  </div>
</div>`;

const page = `<html><body>${header}${sidebar}<main><h1>Install</h1></main></body></html>`;

describe('generic site navigation', () => {
  it('matches a class by substring, so a profile need not know the theme\'s exact class names', () => {
    const root = parseHtml('<div class="sidebar-group-header">x</div>');
    const element = findAll(root, 'div')[0];
    expect(matchesSelector(element, '[class*=group]')).toBe(true);
    expect(matchesSelector(element, '[class^=sidebar]')).toBe(true);
    expect(matchesSelector(element, '[class$=header]')).toBe(true);
    expect(matchesSelector(element, '[class*=nothing]')).toBe(false);
  });

  it('reads the sidebar rather than the site header, and keeps groups, order and nesting', () => {
    const nodes = extractDomSidebarNavigation(page, url, origin, profile)!;
    // the header's Blog/Pricing/Log in links are chrome; picking that container would migrate the wrong tree
    expect(JSON.stringify(nodes)).not.toContain('/pricing');
    expect(nodes).toEqual([
      { type: 'group', label: 'Guides', children: [
        { type: 'page', url: `${origin}/guides/install`, title: 'Install' },
        { type: 'group', label: 'Configure', pageUrl: `${origin}/guides/configure`, children: [
          { type: 'page', url: `${origin}/guides/configure/env`, title: 'Environment' },
          { type: 'page', url: `${origin}/guides/configure/secrets`, title: 'Secrets' },
        ] },
      ] },
      { type: 'group', label: 'Reference', children: [
        { type: 'page', url: `${origin}/reference/cli`, title: 'CLI' },
      ] },
    ]);
  });

  it('keeps a status pill out of the entry label', () => {
    const nodes = extractDomSidebarNavigation(page, url, origin, profile)!;
    // the entry renders "ConfigureBeta"; the label the source states is "Configure"
    expect(JSON.stringify(nodes)).not.toContain('Beta');
  });

  it('never names a group after the links inside it', () => {
    // `.sidebar-group` wraps the whole group and matches [class*=group]; its text is every entry in it
    const nodes = extractDomSidebarNavigation(page, url, origin, profile)!;
    const labels = nodes.flatMap((node) => (node.type === 'group' ? [node.label] : []));
    expect(labels).toEqual(['Guides', 'Reference']);
    for (const label of labels) expect(label).not.toMatch(/Install|Configure|CLI/);
  });
});
