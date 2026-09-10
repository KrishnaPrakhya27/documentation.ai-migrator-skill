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
    navLinkSelector: 'aside a.toclink, aside a[href]',
    recognisers: [
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
    recognisers: [{ selector: '.fern-callout', name: 'Callout', props: { kind: '@attr:data-intent' } }, { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] }],
    assetHosts: [],
  },
  generic: {
    platform: 'generic',
    signals: [],
    articleSelector: 'article, main, [role=main], #content, .content',
    removeSelectors: ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', '[role=navigation]', '.sidebar', '.toc', '.breadcrumb', '.breadcrumbs'],
    navSelector: 'nav, aside, .sidebar',
    navLinkSelector: 'nav a[href], aside a[href], .sidebar a[href]',
    recognisers: [
      { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] },
      { selector: '.admonition, .callout, .alert, .note, .warning, .tip, .info', name: 'admonition', props: { kind: '@class-suffix:' } },
    ],
    assetHosts: [],
  },
};

export function getProfile(platform: string): ScrapeProfile {
  return PROFILES[platform] ?? PROFILES.generic;
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
