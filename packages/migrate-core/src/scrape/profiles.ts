/**
 * Scrape profiles: declarative per-platform knowledge for fingerprinting,
 * article extraction and component recognition. One scraper engine runs them,
 * the same way one rules engine runs the mapping tables.
 *
 * Fingerprints verified against live sites on 2026-09-09 (see the industry
 * research in the architecture report). Selectors drift; each profile ships a
 * fingerprint test that must be run against a live page in CI.
 */
import type { ComponentRecogniser, HtmlAdapterOptions } from '../ir/from-html.js';

export interface Signal {
  kind: 'meta' | 'dom' | 'asset' | 'path' | 'archive' | 'md-suffix';
  /** meta: name=content regex; dom: selector; asset: host substring; path: file present in repo/archive; archive: glob-ish; md-suffix: platform serves .md */
  pattern: string;
  weight: number;
}

export interface ScrapeProfile {
  platform: string;
  signals: Signal[];
  articleSelector?: string;
  removeSelectors: string[];
  navSelector?: string;
  navLinkSelector?: string;
  /** Group heading inside the rendered sidebar. Required to recover navigation from the DOM as an independent witness. */
  navGroupSelector?: string;
  /** List holding a sidebar page's subpages, rendered as the next sibling of the page's link. The link then names a nested group. */
  navChildListSelector?: string;
  /**
   * Site-level section switcher rendered outside the page sidebar (GitBook renders one
   * sidebar per section). Each match is a section link; the section becomes a `tab`
   * container holding the sidebar its own pages render, which is the structure the
   * source presents. Without it a multi-section site collapses into one flat sidebar.
   */
  navSectionSelector?: string;
  /**
   * Badge or tag rendered inside a sidebar entry (GitBook's "Beta" tag). Its text is not
   * part of the label the source states, so it is excluded rather than concatenated onto it.
   */
  navBadgeSelector?: string;
  recognisers: ComponentRecogniser[];
  /** Elements the theme renders as paragraphs without a <p> tag. */
  paragraphSelectors?: string[];
  /** Extractor for the rendered code-block language attribute; the language-* class is the fallback. */
  codeLanguage?: string;
  /**
   * Fence info-string directives that are the platform's own theming, not authored content
   * (Mintlify writes ```bash theme={null}). They are removed from the emitted meta because the
   * target contract rejects the expression, and kept on the node as `sourceMeta`.
   */
  codeMetaStrip?: string[];
  /** Theme strings that surround authored content in the rendered HTML; none may reach migrated output. */
  chromeStrings?: string[];
  /** Platform serves raw markdown at <url>.md; prefer it over HTML. */
  mdSuffix?: boolean;
  /** Host suffixes under which the platform serves one site: the same slug under any of them is the same site (`<slug>.mintlify.site` ⇄ `<slug>.mintlify.app`). */
  hostAliasSuffixes?: string[][];
  /** Hosts whose assets must be rehosted (source CDN). */
  assetHosts: string[];
}

/** The other hosts a profile declares to serve the same site as `host`; empty when the host is not on one of the platform's paired suffixes. */
export function profileHostAliases(profile: ScrapeProfile, host: string): string[] {
  const hostname = host.toLowerCase();
  for (const suffixes of profile.hostAliasSuffixes ?? []) {
    const suffix = suffixes.find((candidate) => hostname.endsWith(candidate) && hostname.length > candidate.length);
    if (!suffix) continue;
    const slug = hostname.slice(0, -suffix.length);
    return suffixes.filter((candidate) => candidate !== suffix).map((candidate) => slug + candidate);
  }
  return [];
}

/**
 * Visible text and accessible names the Mintlify theme adds around the article
 * (assistant bar, table of contents, pagination, code and image buttons, footer,
 * header). Page-specific chrome (the group eyebrow above the H1, Step numbers) is
 * removed structurally by the profile rather than listed here.
 */
const MINTLIFY_CHROME_STRINGS: string[] = [
  'Skip to main content',
  'Search...',
  'Open search',
  'Change theme preference',
  'Ask Assistant',
  'Ask a question...',
  '⌘I',
  'Send message',
  'Add attachment',
  'Close assistant panel',
  'Maximize assistant panel',
  'Toggle assistant panel',
  'Responses are generated using AI and may contain mistakes.',
  'On this page',
  'Navigate to header',
  'Expand image',
  'Copy the contents from the code block',
  'Copy page',
  'Ask AI',
  'Was this page helpful?',
  'Previous:',
  'Next:',
  'Powered by',
];

/**
 * Chrome every documentation theme renders around the article regardless of platform:
 * the skip link, the on-page table of contents, the feedback prompt, the copy control and
 * the edit link. Each profile spreads this and adds its own theme's strings.
 */
const COMMON_CHROME_STRINGS: string[] = [
  'Skip to main content',
  'On this page',
  'Table of contents',
  'Edit this page',
  'Was this page helpful?',
  'Copy',
  'Previous',
  'Next',
];

const EMOJI_CALLOUT: ComponentRecogniser[] = [
  { selector: 'blockquote.callout_info, blockquote.callout_default', name: 'Callout', props: { kind: 'info' } },
  { selector: 'blockquote.callout_okay', name: 'Callout', props: { kind: 'success' } },
  { selector: 'blockquote.callout_warn', name: 'Callout', props: { kind: 'alert' } },
  { selector: 'blockquote.callout_error', name: 'Callout', props: { kind: 'danger' } },
];

export const PROFILES: Record<string, ScrapeProfile> = {
  readme: {
    platform: 'readme',
    signals: [
      { kind: 'meta', pattern: 'readme-deploy=.*', weight: 3 },
      { kind: 'dom', pattern: '.rm-Sidebar', weight: 3 },
      { kind: 'dom', pattern: '#hub-container', weight: 2 },
      { kind: 'dom', pattern: '#ssr-props', weight: 2 },
      { kind: 'dom', pattern: '.rm-Markdown.markdown-body', weight: 2 },
      { kind: 'asset', pattern: 'cdn.readme.io', weight: 1 },
      { kind: 'asset', pattern: 'files.readme.io', weight: 1 },
      { kind: 'md-suffix', pattern: '', weight: 1 },
    ],
    articleSelector: '.rm-Markdown.markdown-body',
    removeSelectors: ['.rm-Header', '.rm-ToC', '.rm-Pagination', '.rm-TryIt', '.rm-PlaygroundRequest', '.rm-PlaygroundResponse', 'nav', 'header', 'footer'],
    navSelector: '.rm-Sidebar',
    navLinkSelector: '.rm-Sidebar-link',
    // Current ReadMe renders each category as a collapsible `button.rm-Sidebar-category`; older hubs used `.rm-Sidebar-heading`.
    navGroupSelector: '.rm-Sidebar-heading, .rm-Sidebar-category',
    navChildListSelector: '.rm-Sidebar-list',
    navSectionSelector: '.rm-Header-bottom-link',
    chromeStrings: [...COMMON_CHROME_STRINGS, 'Powered by ReadMe', 'Suggest Edits', 'Ask AI', 'Did this page help you?', 'Updated'],
    recognisers: [
      ...EMOJI_CALLOUT,
      { selector: 'details.rm-Accordion, .rm-Accordion', name: 'Accordion', props: { title: '@text:summary' }, strip: ['summary'] },
      { selector: '.rm-Tabs', name: 'Tabs' },
      { selector: '.rm-Tab', name: 'Tab', props: { title: '@attr:data-title' } },
      { selector: '.rm-Cards', name: 'Cards', props: { columns: '@count:.rm-Card' } },
      { selector: '.rm-Card', name: 'Card', props: { title: '@text:.rm-Card-title', href: '@attr:href' } },
      { selector: '.rm-Embed, .embed', name: 'embed', props: { src: '@attr:data-src', title: '@attr:data-title' } },
    ],
    mdSuffix: true,
    assetHosts: ['files.readme.io', 'cdn.readme.io'],
  },
  mintlify: {
    platform: 'mintlify',
    signals: [
      { kind: 'meta', pattern: 'generator=Mintlify', weight: 4 },
      { kind: 'meta', pattern: 'application-name=Mintlify', weight: 2 },
      { kind: 'dom', pattern: '#content-area', weight: 2 },
      { kind: 'dom', pattern: '#sidebar-content', weight: 2 },
      { kind: 'dom', pattern: '#navigation-items', weight: 1 },
      { kind: 'asset', pattern: 'mintcdn.com', weight: 1 },
      { kind: 'path', pattern: 'docs.json', weight: 5 },
      { kind: 'path', pattern: 'mint.json', weight: 5 },
      { kind: 'md-suffix', pattern: '', weight: 2 },
    ],
    articleSelector: '#content-area',
    // `header` carries the group eyebrow, #page-title and the description, all of which come from
    // llms.txt / the published .md instead. The assistant bar is removed together with everything
    // inside it (the descendant forms cover the unlabeled "\u2318I" shortcut span, the textarea and the
    // send button even if a theme re-parents the bar). The last selector drops Mintlify's
    // per-heading hover anchor (a zero-width space + icon inside every h1-h6), which otherwise
    // survives as a "[\u200b](#slug)" prefix on each heading.
    removeSelectors: [
      '#table-of-contents-content', '#sidebar-content', '#navigation-items', 'nav', 'header', 'footer', '.eyebrow', '[data-feedback]',
      '[data-assistant-bar]', '[data-assistant-bar] *', '.chat-assistant-floating-input', '.chat-assistant-floating-input *', '#chat-assistant-textarea', '.chat-assistant-send-button',
      '#pagination', '[data-floating-buttons]', 'button[aria-label="Expand image"]', 'a[aria-label="Navigate to header"]',
    ],
    navSelector: '#sidebar-content',
    navLinkSelector: '#sidebar-content a[href]',
    navGroupSelector: '.sidebar-group-header',
    paragraphSelectors: ['span[data-as="p"]'],
    codeLanguage: '@attr:language',
    codeMetaStrip: ['theme=\\{[^}]*\\}'],
    chromeStrings: MINTLIFY_CHROME_STRINGS,
    recognisers: [
      { selector: '.callout, [data-callout]', name: 'Callout', props: { kind: '@attr:data-callout-type' } },
      { selector: 'details.accordion, .accordion', name: 'Accordion', props: { title: '@text:summary' }, strip: ['summary'] },
      { selector: '.accordion-group', name: 'AccordionGroup' },
      { selector: '.card-group', name: 'CardGroup', props: { cols: '@style-var:--cols' } },
      { selector: '.card', name: 'Card', props: { title: '@part:card-title', href: '@attr-or-descendant:href' } },
      { selector: '.tabs', name: 'Tabs' },
      { selector: '[role=tabpanel]', name: 'Tab', props: { title: '@attr:aria-label' } },
      { selector: '.frame, figure.frame', name: 'Frame', props: { caption: '@text:figcaption' }, strip: ['figcaption'] },
      { selector: '.steps', name: 'Steps' },
      { selector: '.step', name: 'Step', props: { title: '@part:step-title' }, strip: ['[data-component-part="step-number"]', '[data-component-part="step-line"]'] },
    ],
    mdSuffix: true,
    hostAliasSuffixes: [['.mintlify.site', '.mintlify.app']],
    assetHosts: ['mintcdn.com', 'mintlify.s3-us-west-1.amazonaws.com', 'mintlify.s3.us-west-1.amazonaws.com'],
  },
  gitbook: {
    platform: 'gitbook',
    signals: [
      { kind: 'meta', pattern: 'generator=GitBook.*', weight: 4 },
      { kind: 'asset', pattern: 'fonts.gitbook.com', weight: 1 },
      { kind: 'asset', pattern: 'static-2v.gitbook.com', weight: 1 },
      { kind: 'dom', pattern: 'main.page-has-toc', weight: 2 },
      { kind: 'dom', pattern: '.page-document-item', weight: 2 },
      { kind: 'dom', pattern: '#space-dropdown-button', weight: 1 },
      { kind: 'path', pattern: '.gitbook.yaml', weight: 5 },
      { kind: 'path', pattern: 'SUMMARY.md', weight: 3 },
      { kind: 'md-suffix', pattern: '', weight: 1 },
    ],
    articleSelector: 'main',
    removeSelectors: ['aside', 'nav', 'header', 'footer', '[data-testid="page-footer"]', '.toc'],
    navSelector: 'aside',
    navLinkSelector: 'aside a.toclink',
    navBadgeSelector: 'aside [data-tag]',
    navGroupSelector: 'aside .toc-group, aside [data-testid="table-of-contents-group"]',
    navChildListSelector: 'aside li div',
    navSectionSelector: '[data-gb-sections] a[href]',
    chromeStrings: [...COMMON_CHROME_STRINGS, 'Powered by GitBook', 'Was this helpful?', 'Last updated', 'Ask or search…', 'Ctrl K'],
    recognisers: [
      { selector: 'button[data-action=ask]', name: 'button', props: { 'data-action': '@attr:data-action' } },
      { selector: '.hint, [data-hint]', name: 'hint', props: { style: '@class-suffix:hint-' } },
      { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] },
      { selector: '[role=tablist]', name: 'tabs' },
      { selector: '[role=tabpanel]', name: 'tab', props: { title: '@attr:aria-label' } },
      { selector: '.embed, [data-embed]', name: 'embed', props: { src: '@attr:data-url' } },
    ],
    mdSuffix: true,
    assetHosts: ['files.gitbook.io', 'gitbook.io', 'gitbookusercontent.com'],
  },
  document360: {
    platform: 'document360',
    signals: [
      { kind: 'dom', pattern: '#articleContent', weight: 3 },
      { kind: 'dom', pattern: '.editor360-published-content', weight: 3 },
      { kind: 'dom', pattern: '#serverApp', weight: 2 },
      { kind: 'asset', pattern: 'cdn.document360.io', weight: 2 },
      { kind: 'archive', pattern: '_category_articles.json', weight: 5 },
      { kind: 'archive', pattern: 'Articles/', weight: 2 },
    ],
    articleSelector: '#articleContent, .editor360-published-content',
    removeSelectors: ['nav', 'header', 'footer', '.breadcrumb', '.article-feedback', '.related-articles', '.article-info'],
    navSelector: '.category-tree, nav',
    navLinkSelector: 'a[href*="/docs/"]',
    navGroupSelector: '.category-tree .category-name, .category-tree .tree-category',
    chromeStrings: [...COMMON_CHROME_STRINGS, 'Was this article helpful?', 'Print', 'Updated on', 'Table of Contents'],
    recognisers: [
      { selector: 'blockquote.infoBox', name: 'infoBox' },
      { selector: 'blockquote.warningBox', name: 'warningBox' },
      { selector: 'blockquote.errorBox', name: 'errorBox' },
      { selector: 'blockquote.successBox', name: 'successBox' },
      { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] },
      { selector: 'editor360-faq', name: 'faq' },
    ],
    assetHosts: ['cdn.document360.io'],
  },
  docusaurus: {
    platform: 'docusaurus',
    signals: [
      { kind: 'meta', pattern: 'generator=Docusaurus.*', weight: 4 },
      { kind: 'dom', pattern: '.theme-doc-markdown', weight: 3 },
      { kind: 'dom', pattern: '.theme-doc-sidebar-container', weight: 2 },
      { kind: 'dom', pattern: '.navbar__item', weight: 1 },
      { kind: 'path', pattern: 'docusaurus.config.js', weight: 5 },
      { kind: 'path', pattern: 'docusaurus.config.ts', weight: 5 },
      { kind: 'path', pattern: 'versioned_docs/', weight: 2 },
    ],
    articleSelector: '.theme-doc-markdown',
    removeSelectors: ['.theme-doc-sidebar-container', '.theme-doc-toc-desktop', '.pagination-nav', 'nav', 'footer', '.theme-doc-footer'],
    navSelector: '.theme-doc-sidebar-container',
    navLinkSelector: '.theme-doc-sidebar-container a[href]',
    navGroupSelector: '.theme-doc-sidebar-item-category > .menu__list-item-collapsible > .menu__link',
    chromeStrings: [...COMMON_CHROME_STRINGS, 'Was this helpful?', 'Last updated on', 'Scroll back to top'],
    recognisers: [
      { selector: '.theme-admonition', name: 'admonition', props: { kind: '@class-suffix:theme-admonition-' } },
      { selector: '.tabs-container', name: 'Tabs' },
      { selector: '[role=tabpanel]', name: 'Tab', props: { title: '@attr:aria-label' } },
      { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] },
    ],
    assetHosts: [],
  },
  nextra: {
    platform: 'nextra',
    signals: [
      { kind: 'meta', pattern: 'application-name=Nextra', weight: 4 },
      { kind: 'dom', pattern: '.nextra-content', weight: 2 },
      { kind: 'path', pattern: '_meta.js', weight: 3 },
      { kind: 'path', pattern: '_meta.ts', weight: 3 },
    ],
    articleSelector: 'main',
    removeSelectors: ['nav', 'aside', 'footer', '.nextra-toc', '.nextra-sidebar-container'],
    navSelector: '.nextra-sidebar-container',
    navLinkSelector: '.nextra-sidebar-container a[href]',
    navGroupSelector: '.nextra-sidebar-container .nextra-menu-desktop > li > button',
    chromeStrings: [...COMMON_CHROME_STRINGS, 'On This Page', 'Question? Give us feedback', 'Scroll to top'],
    recognisers: [{ selector: '.nextra-callout', name: 'Callout', props: { kind: '@attr:data-type' } }, { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] }],
    assetHosts: [],
  },
  readthedocs: {
    platform: 'readthedocs',
    signals: [
      { kind: 'dom', pattern: '.wy-nav-side', weight: 3 },
      { kind: 'dom', pattern: '.rst-content', weight: 3 },
      { kind: 'dom', pattern: '#rtd-search-form', weight: 2 },
      { kind: 'path', pattern: '.readthedocs.yaml', weight: 5 },
      { kind: 'path', pattern: 'conf.py', weight: 2 },
    ],
    articleSelector: '.rst-content',
    removeSelectors: ['.wy-nav-side', '.rst-footer-buttons', 'footer', 'nav'],
    navSelector: '.wy-nav-side',
    navLinkSelector: '.wy-menu a[href]',
    navGroupSelector: '.wy-menu > p.caption',
    chromeStrings: [...COMMON_CHROME_STRINGS, 'Read the Docs', 'Edit on GitHub', 'Built with Sphinx', 'Search docs'],
    recognisers: [{ selector: '.admonition', name: 'admonition', props: { kind: '@class-suffix:admonition-' }, strip: ['.admonition-title'] }],
    assetHosts: [],
  },
  fern: {
    platform: 'fern',
    signals: [
      { kind: 'dom', pattern: '.fern-sidebar', weight: 3 },
      { kind: 'dom', pattern: '.fern-layout-main', weight: 2 },
      { kind: 'asset', pattern: '_fern-files', weight: 2 },
      { kind: 'path', pattern: 'fern/docs.yml', weight: 5 },
    ],
    articleSelector: '.fern-layout-main, main',
    removeSelectors: ['.fern-sidebar', '.fern-toc', 'nav', 'footer'],
    navSelector: '.fern-sidebar',
    navLinkSelector: '.fern-sidebar a[href]',
    navGroupSelector: '.fern-sidebar .fern-sidebar-heading',
    chromeStrings: [...COMMON_CHROME_STRINGS, 'Built with Fern'],
    recognisers: [{ selector: '.fern-callout', name: 'Callout', props: { kind: '@attr:data-intent' } }, { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] }],
    assetHosts: [],
  },
  /**
   * MadCap Flare's published HTML5 output.
   *
   * Every selector here was taken from a 448-page capture of a real Flare site, not from Flare's
   * documentation: `#mc-main-content` and `div[data-mc-content-body]` wrap the topic on all 448,
   * and the skin puts everything else — the title bar, the off-canvas drawer, the search bar, the
   * account menu, the footer — outside them.
   *
   * The sidebar is deliberately not recovered from the DOM. Flare serves `nav[data-mc-side-nav-menu]`
   * empty and fills it in the browser, so the rendered HTML states no navigation at all; the real
   * tree is read from the published data files by `scrape/madcap-toc.ts`.
   */
  madcap: {
    platform: 'madcap',
    signals: [
      // The attribute Flare writes on <html> to point a page at its help system: the surest mark of
      // published Flare output, and the same one the navigation reader keys on.
      { kind: 'asset', pattern: 'data-mc-path-to-help-system', weight: 5 },
      { kind: 'dom', pattern: '[data-mc-content-body]', weight: 3 },
      { kind: 'dom', pattern: '#mc-main-content', weight: 3 },
      { kind: 'dom', pattern: 'nav[data-mc-side-nav-menu]', weight: 2 },
      { kind: 'path', pattern: 'Project/TOCs', weight: 5 },
      { kind: 'archive', pattern: '.flprj', weight: 5 },
    ],
    articleSelector: '#mc-main-content, [data-mc-content-body]',
    removeSelectors: [
      '.skip-to-content', '.title-bar-container', '.off-canvas', '.search-bar-container', '.central-account-wrapper', 'nav[data-mc-side-nav-menu]', 'footer',
      // Flare renders skin components *inside* the topic body and marks them `nocontent` — its own
      // statement that they are not content. On a surveyed site these are the topic toolbar's
      // Previous/Next buttons (406 pages) and the menu skins (18); not one is authored text.
      // `mc-component` is required alongside so a topic that writes the word itself keeps it.
      '.mc-component.nocontent',
      // The skin's search boxes: one in the nav, one in the landing-page hero. `.search-bar-container`
      // above takes their innards, which would otherwise leave the wrapper and an empty
      // <form class="search"> behind as a component of its own. The hero's heading is left alone:
      // it is the title those pages state, and stating it is the source's business, not this rule's.
      '.nav-search-wrapper', 'form.search',
      // A cookie-consent control the page template injects. Not Flare's, and never documentation.
      '#ot-sdk-btn', '.ot-sdk-show-settings',
      // The copy control Flare draws above a code snippet. Its javascript: href is stripped as an
      // unsafe URL, which used to leave the bare word "Copy" sitting above the code as if authored.
      // The snippet's caption beside it is authored text and stays.
      '.codeSnippetCopyButton',
    ],
    // Recorded as the independent witness verification cross-checks; it is empty on a live site,
    // and `navigationData` carries the tree the site actually renders.
    navSelector: 'nav[data-mc-side-nav-menu], .sidenav-wrapper',
    navLinkSelector: 'a[href]',
    // Only strings the skin renders as a block of their own. The dropdown icon's "Closed"/"Open"
    // alt text is deliberately absent: it never reaches output (the head is stripped), and both are
    // ordinary words a topic may put on a line by itself.
    chromeStrings: [...COMMON_CHROME_STRINGS, 'Skip To Main Content'],
    recognisers: [
      // A collapsible section: the head holds the clickable label, the body holds the content.
      { selector: '.MCDropDown', name: 'MCDropDown', props: { title: '@text:.MCDropDownHead' }, strip: ['.MCDropDownHead'] },
      { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] },
      // `.MCExpanding` is left whole on purpose. Its hotspot label is authored text and its body is
      // authored content, but the two are siblings of the topic content rather than a head and a
      // body, so there is no summary/content split to make without discarding or re-parenting what
      // the author wrote. Passing it through keeps every word; only the collapse is not reproduced.
    ],
    assetHosts: [],
  },
  generic: {
    platform: 'generic',
    signals: [],
    articleSelector: 'article, main, [role=main], #content, .content',
    // A form is interactive chrome a static migration can never carry: a site search, a feedback
    // widget, a filter. Themes render it inside the article region, so removing the element takes
    // its inputs and buttons with it instead of leaving them stranded in the page.
    removeSelectors: ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'form', '[role=navigation]', '[role=search]', '.sidebar', '.toc', '.breadcrumb', '.breadcrumbs'],
    // Containers in preference order: the documentation sidebar before the page's own <nav>,
    // which on most sites is the site header. The first one holding navigation is used.
    navSelector: '.sidebar, [role=navigation], aside, nav',
    navLinkSelector: 'a[href]',
    // A generic theme labels a sidebar group with whatever it likes: a heading, a collapsible
    // button, or a div whose class names it. A candidate containing links is a wrapper, not a label.
    navGroupSelector: 'h2, h3, h4, h5, h6, strong, button, summary, [class*=group], [class*=category], [class*=section], [class*=heading]',
    // The common HTML shape for subpages: a list right after the page's own link.
    navChildListSelector: 'ul, ol',
    // A status pill rendered inside an entry ("Beta", "New") decorates the label, it is not part of it.
    navBadgeSelector: '[data-tag], [class*=badge], [class*=pill], [class*=chip]',
    chromeStrings: COMMON_CHROME_STRINGS,
    recognisers: [
      { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] },
      { selector: '.admonition, .callout, .alert, .note, .warning, .tip, .info', name: 'admonition', props: { kind: '@class-suffix:' } },
      // Flare output reached through the generic profile (an unfingerprinted host, or an operator's
      // explicit --platform generic) still renders its collapsible sections; the madcap profile
      // above is where the rest of Flare's markup is recognised.
      { selector: '.MCDropDown', name: 'MCDropDown', props: { title: '@text:.MCDropDownHead' }, strip: ['.MCDropDownHead'] },
    ],
    assetHosts: [],
  },
};

/** Platform ids that have a scrape profile; anything else is a typo or an unsupported platform. */
export function knownPlatforms(): string[] {
  return Object.keys(PROFILES).sort();
}

/**
 * The profile for a platform id. An unknown id is refused rather than served the generic
 * profile: a substitute declares no published Markdown, no chrome and no navigation witness,
 * and nothing downstream could tell its weaker checks from real ones.
 */
export function getProfile(platform: string): ScrapeProfile {
  const profile = PROFILES[platform];
  if (!profile) throw new Error(`no scrape profile for platform "${platform}"; known platforms: ${knownPlatforms().join(', ')}. Pass one of these to --platform (or --profile), or add a profile.`);
  return profile;
}

/** The adapter options a profile implies for one scraped page, so no call site can leave a profile field behind. */
export function htmlAdapterOptions(profile: ScrapeProfile, page: { platform: string; file: string }): HtmlAdapterOptions {
  return {
    platform: page.platform,
    file: page.file,
    articleSelector: profile.articleSelector,
    removeSelectors: profile.removeSelectors,
    recognisers: profile.recognisers,
    paragraphSelectors: profile.paragraphSelectors,
    codeLanguage: profile.codeLanguage,
  };
}
