import { describe, it, expect } from 'vitest';
import { navigationFromFrozenPages, extractSectionTabs } from '../src/scrape/discovery.js';
import { getProfile } from '../src/scrape/profiles.js';

/**
 * GitBook renders the section switcher of the section being read, so a translated section names
 * itself and its siblings in its own locale. No single page states them all.
 */
const page = (sections: Array<[string, string]>, sidebar: Array<[string, string]>): string => `
<html><body>
  <div data-gb-sections>
    ${sections.map(([label, href]) => `<a href="${href}">${label}</a>`).join('')}
  </div>
  <aside>
    ${sidebar.map(([label, href]) => `<a class="toclink" href="${href}">${label}</a>`).join('')}
  </aside>
  <main class="page-has-toc"><p>body</p></main>
</body></html>`;

const EN: Array<[string, string]> = [['Documentation', '/docs'], ['Developers', '/docs/developers']];
const FR: Array<[string, string]> = [['Documentation', '/docs/documentation/fr'], ['Développeurs', '/docs/developers']];
const ZH: Array<[string, string]> = [['文档', '/docs/documentation/zh'], ['开发者', '/docs/developers']];

const pages = [
  { url: 'https://gitbook.com/docs', html: page(EN, [['Quickstart', '/docs/getting-started/quickstart']]) },
  { url: 'https://gitbook.com/docs/developers', html: page(EN, [['API', '/docs/developers/api']]) },
  { url: 'https://gitbook.com/docs/documentation/fr', html: page(FR, [['Démarrage rapide', '/docs/documentation/fr/getting-started/quickstart']]) },
  { url: 'https://gitbook.com/docs/documentation/zh', html: page(ZH, [['快速入门', '/docs/documentation/zh/getting-started/quickstart']]) },
];

describe('sections re-read from frozen pages', () => {
  it('one page states only its own section and its siblings, never another locale’s', () => {
    const stated = extractSectionTabs(pages[0].html, pages[0].url, 'https://gitbook.com', getProfile('gitbook'));
    expect(stated?.map((s) => s.label)).toEqual(['Documentation', 'Developers']);
    expect(stated?.some((s) => s.url.includes('/fr'))).toBe(false);
  });

  it('takes the union across pages, so a translated section is its own tab rather than merged into the English one', () => {
    const nav = navigationFromFrozenPages(pages, 'gitbook', 'https://gitbook.com/docs', 'https://gitbook.com', getProfile('gitbook'));
    expect(nav?.source).toBe('dom-sidebar');
    const tabs = (nav?.nodes ?? []).filter((n: any) => n.type === 'group');
    expect(tabs.map((t: any) => t.label)).toEqual(['Documentation', 'Developers', 'Documentation', '文档']);
    // the English tab holds only English pages: the regression merged all four into it
    const english = tabs[0] as any;
    expect(JSON.stringify(english)).not.toContain('/fr/');
    expect(JSON.stringify(english)).not.toContain('/zh/');
  });

  it('keeps the first label for a section every locale links to', () => {
    const nav = navigationFromFrozenPages(pages, 'gitbook', 'https://gitbook.com/docs', 'https://gitbook.com', getProfile('gitbook'));
    const developers = (nav?.nodes ?? []).filter((n: any) => n.type === 'group')[1] as any;
    // Développeurs and 开发者 name the same section; the first reading wins rather than the last
    expect(developers.label).toBe('Developers');
  });
});
