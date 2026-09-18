/**
 * An icon for a navigation entry whose source states none.
 *
 * The platform draws an icon beside a sidebar row whenever the entry carries one, and the
 * documentation the platform itself publishes carries one on every page and every tab. A source
 * that had nowhere to say it — a GitBook or Docusaurus sidebar states a link and its text and
 * nothing else — therefore migrates into a sidebar that reads plainer than the same pages written
 * in the editor, for a reason no reader can see. This proposes an icon from what an entry calls
 * itself, and never touches one the source does state.
 *
 * Two properties make that safe to write unseen. It is deterministic: the same label always yields
 * the same icon, so a migration re-run produces the same file and the preview check compares like
 * with like. And every name is checked against the renderer's own icon list before it is written,
 * so an entry never carries a name that silently draws nothing. The site plan decides whether any
 * of this is written at all, and a person reviews the result at gate 2 with the other plans.
 */
import { drawableIconName, loadContract } from '@dai/content-contract';

/** What the site plan asks for. `source` writes only what the source states; `none` writes no icon at all. */
export type IconPolicy = 'source' | 'suggested' | 'none';

export const ICON_POLICIES: readonly IconPolicy[] = ['source', 'suggested', 'none'];

/**
 * A container's own fallback, used when its label says nothing this can read. A container is one
 * row among few and its icon reads as a section marker, so a generic one still helps; a page is one
 * row among many, and a column of identical icons reads worse than none, which is why pages have no
 * unconditional fallback.
 */
const CONTAINER_FALLBACK: Record<string, string> = {
  tab: 'book',
  dropdown: 'layers',
  menu: 'layers',
  group: 'folder',
  product: 'box',
  version: 'git-branch',
  language: 'languages',
};

/**
 * Filler for the pages of a container that mostly matched. Rows are laid out inline, so a container
 * where some pages carry an icon and some do not has ragged text; either every page in it gets one
 * or none does. A container this far matched is about a subject this can read, so the rest are
 * documents about it.
 */
const PAGE_FILLER = 'file-text';

/** The share of a container's pages that must match by name before the rest are filled in. */
const PAGE_FILL_THRESHOLD = 0.5;

/**
 * Whole-label readings, tried in order before single words. These exist where the words apart say
 * something different from the words together: "getting started" is not "start", and "release
 * notes" is not "note".
 */
const PHRASES: ReadonlyArray<readonly [string, string]> = [
  ['getting started', 'rocket'], ['get started', 'rocket'], ['first steps', 'rocket'], ['quick start', 'zap'],
  ['release notes', 'clock'], ["what's new", 'sparkles'], ['whats new', 'sparkles'], ['coming soon', 'clock'],
  ['product update', 'refresh-cw'], ['product updates', 'refresh-cw'],
  // A "Migrate from X" family is one row per platform, and reading only the verb gives every row
  // the same arrow. The platform is the part that differs, so it is the part that gets drawn.
  ['mintlify', 'leaf'], ['gitbook', 'book-marked'], ['readme', 'book-open-text'], ['document360', 'library'],
  ['docusaurus', 'square-code'], ['confluence', 'layout'], ['notion', 'file-text'], ['fern', 'sprout'],
  ['nextra', 'square-code'], ['zendesk', 'headset'], ['intercom', 'message-circle'], ['wordpress', 'globe'],
  ['markdown', 'file-text'], ['swagger', 'braces'], ['openapi', 'braces'], ['postman', 'send'],
  ['core concepts', 'cog'], ['key concepts', 'cog'], ['how it works', 'cog'],
  ['api reference', 'code'], ['api keys', 'key'], ['rest api', 'code'], ['graphql', 'braces'],
  ['help center', 'circle-help'], ['help centre', 'circle-help'], ['frequently asked questions', 'circle-help'],
  ['common issues', 'triangle-alert'], ['known issues', 'triangle-alert'], ['error codes', 'circle-alert'],
  ['best practices', 'award'], ['style guide', 'palette'], ['design system', 'palette'],
  ['access control', 'shield'], ['single sign on', 'key'], ['two factor', 'shield-check'],
  ['rate limits', 'gauge'], ['rate limiting', 'gauge'], ['service limits', 'gauge'],
  ['client libraries', 'package'], ['command line', 'terminal'], ['code examples', 'code'],
  ['custom domain', 'globe'], ['custom domains', 'globe'], ['custom css', 'palette'],
  ['data model', 'database'], ['data models', 'database'], ['schema reference', 'database'],
  ['self host', 'server'], ['self hosting', 'server'], ['on premise', 'server'],
  ['use cases', 'lightbulb'], ['case studies', 'lightbulb'], ['tips and tricks', 'lightbulb'],
  ['team members', 'users'], ['user management', 'users'], ['single tenant', 'building'],
  ['terms of service', 'scroll'], ['privacy policy', 'lock'], ['service level', 'scale'],
  ['table of contents', 'list'], ['site map', 'map'], ['sitemap', 'map'],
  ['pull request', 'git-pull-request'], ['source control', 'git-branch'], ['version control', 'git-branch'],
  ['continuous integration', 'workflow'], ['ci cd', 'workflow'],
];

/**
 * A word's reading. Scanned left to right across the label, so the first word this knows decides:
 * a title leads with its subject far more often than it ends with it.
 */
const KEYWORDS: Readonly<Record<string, string>> = {
  // openings
  introduction: 'star', intro: 'star', welcome: 'sparkles', overview: 'info', about: 'info',
  start: 'rocket', quickstart: 'zap', onboarding: 'rocket', basics: 'graduation-cap', begin: 'rocket',
  home: 'house', index: 'house', main: 'house',
  // the craft of documentation
  guide: 'book-open', guides: 'book-open', tutorial: 'graduation-cap', tutorials: 'graduation-cap',
  walkthrough: 'footprints', howto: 'book-open', reference: 'book-marked', glossary: 'book-a',
  concept: 'cog', concepts: 'cog', example: 'code', examples: 'code', sample: 'code', samples: 'code',
  recipe: 'book-open', recipes: 'book-open', cookbook: 'book-open', faq: 'circle-help', faqs: 'circle-help',
  documentation: 'book', docs: 'book', manual: 'book', handbook: 'book',
  // moving in and out
  migration: 'arrow-right-left', migrate: 'arrow-right-left', import: 'download', importing: 'download',
  export: 'upload', exporting: 'upload', upload: 'upload', download: 'download', install: 'download',
  installation: 'download', setup: 'wrench', upgrade: 'trending-up', checklist: 'list-checks',
  // the product's own machinery
  api: 'code', endpoint: 'code', endpoints: 'code', webhook: 'webhook', webhooks: 'webhook',
  sdk: 'package', sdks: 'package', library: 'library', libraries: 'library', package: 'package',
  cli: 'terminal', command: 'terminal', commands: 'terminal', terminal: 'terminal', shell: 'square-terminal',
  config: 'settings', configuration: 'settings', settings: 'settings', options: 'sliders-horizontal',
  parameter: 'sliders-horizontal', parameters: 'sliders-horizontal', environment: 'server',
  // identity and safety
  auth: 'key', authentication: 'key', authorization: 'shield', login: 'log-in', signin: 'log-in',
  token: 'key', tokens: 'key', key: 'key', keys: 'key', credential: 'key', credentials: 'key',
  secret: 'lock', secrets: 'lock', security: 'shield-check', permission: 'shield', permissions: 'shield',
  role: 'shield', roles: 'shield', privacy: 'lock', compliance: 'shield-check', audit: 'clipboard-list',
  encryption: 'lock', sso: 'key', oauth: 'key',
  // people and money
  user: 'users', users: 'users', team: 'users', teams: 'users', member: 'users', members: 'users',
  account: 'user-check', accounts: 'user-check', profile: 'user-check', organization: 'building',
  workspace: 'layout-grid', workspaces: 'layout-grid', billing: 'credit-card', pricing: 'credit-card',
  payment: 'credit-card', payments: 'credit-card', plan: 'credit-card', plans: 'credit-card',
  subscription: 'credit-card', invoice: 'receipt', invoices: 'receipt', quota: 'gauge', quotas: 'gauge',
  limit: 'gauge', limits: 'gauge', usage: 'gauge',
  // data
  database: 'database', data: 'database', schema: 'database', schemas: 'database', model: 'database',
  models: 'database', table: 'table', tables: 'table', query: 'search', queries: 'search',
  storage: 'hard-drive', backup: 'archive', archive: 'archive', cache: 'zap',
  // what goes wrong
  error: 'circle-alert', errors: 'circle-alert', troubleshooting: 'triangle-alert',
  troubleshoot: 'triangle-alert', debug: 'bug', debugging: 'bug', bug: 'bug', bugs: 'bug',
  issue: 'triangle-alert', issues: 'triangle-alert', log: 'scroll', logs: 'scroll', logging: 'scroll',
  monitoring: 'activity', observability: 'activity', status: 'activity', health: 'heart-pulse',
  uptime: 'activity', incident: 'siren', alerts: 'bell', alert: 'bell',
  // measuring
  analytics: 'chart-column', analytic: 'chart-column', metric: 'chart-column', metrics: 'chart-column',
  report: 'chart-column', reports: 'chart-column', reporting: 'chart-column', dashboard: 'layout-dashboard',
  dashboards: 'layout-dashboard', insight: 'lightbulb', insights: 'lightbulb', chart: 'chart-column',
  performance: 'gauge', benchmark: 'gauge', benchmarks: 'gauge',
  // building and shipping
  deploy: 'cloud-upload', deployment: 'cloud-upload', deployments: 'cloud-upload', hosting: 'server',
  server: 'server', servers: 'server', cloud: 'cloud', docker: 'container', kubernetes: 'boxes',
  infrastructure: 'network', architecture: 'network', workflow: 'workflow', workflows: 'workflow',
  automation: 'workflow', automations: 'workflow', pipeline: 'workflow', build: 'hammer',
  test: 'test-tube', tests: 'test-tube', testing: 'test-tube', release: 'tag', releases: 'tag',
  version: 'git-branch', versions: 'git-branch', versioning: 'git-branch', branch: 'git-branch',
  branches: 'git-branch', changelog: 'clock', history: 'history', roadmap: 'map',
  update: 'refresh-cw', updates: 'refresh-cw', announcement: 'megaphone', announcements: 'megaphone',
  rollback: 'rotate-ccw', patch: 'wrench',
  // commerce and the back office, common in a product's own documentation
  order: 'receipt', orders: 'receipt', inventory: 'boxes', catalog: 'library', product: 'box',
  products: 'box', category: 'tags', categories: 'tags', shipping: 'truck', cart: 'shopping-cart',
  store: 'store', checkout: 'shopping-cart', refund: 'banknote', refunds: 'banknote',
  admin: 'shield', administration: 'shield', console: 'square-terminal', portal: 'layout-grid',
  // the site itself
  page: 'file-text', pages: 'file-text', file: 'file-text', files: 'file-text', document: 'file-text',
  documents: 'file-text', content: 'file-text', editor: 'square-pen', writing: 'square-pen',
  publish: 'send', publishing: 'send', preview: 'eye', navigation: 'menu', sidebar: 'panel-left',
  search: 'search', seo: 'search-check', sitemap: 'map', redirect: 'arrow-right-left',
  redirects: 'arrow-right-left', domain: 'globe', domains: 'globe', url: 'link', urls: 'link',
  link: 'link', links: 'link',
  // how it looks
  theme: 'palette', themes: 'palette', style: 'palette', styles: 'palette', styling: 'palette',
  color: 'palette', colors: 'palette', colours: 'palette', branding: 'award', brand: 'award',
  design: 'palette', layout: 'layout', template: 'layout-template', templates: 'layout-template',
  component: 'component', components: 'component', block: 'blocks', blocks: 'blocks',
  snippet: 'puzzle', snippets: 'puzzle', typography: 'type', font: 'type', fonts: 'type',
  // media
  image: 'image', images: 'image', video: 'video', videos: 'video', media: 'images',
  asset: 'images', assets: 'images', icon: 'shapes', icons: 'shapes', diagram: 'network',
  diagrams: 'network',
  // reaching other systems
  integration: 'puzzle', integrations: 'puzzle', plugin: 'puzzle', plugins: 'puzzle',
  extension: 'puzzle', extensions: 'puzzle', connect: 'plug', connection: 'plug',
  connections: 'plug', app: 'layout-grid', apps: 'layout-grid', platform: 'layers',
  platforms: 'layers', provider: 'plug', providers: 'plug',
  // talking to people
  notification: 'bell', notifications: 'bell', email: 'mail', emails: 'mail', mail: 'mail',
  message: 'message-circle', messages: 'message-circle', chat: 'message-circle',
  comment: 'message-square', comments: 'message-square', support: 'headset', contact: 'headset',
  feedback: 'message-square-heart', community: 'users', contributing: 'handshake',
  contribute: 'handshake', partner: 'handshake', partners: 'handshake',
  // words and places
  language: 'languages', languages: 'languages', localization: 'languages', locale: 'languages',
  translation: 'languages', translations: 'languages', region: 'globe', regions: 'globe',
  // machines that write
  ai: 'sparkles', agent: 'bot', agents: 'bot', bot: 'bot', prompt: 'message-square',
  prompts: 'message-square', llm: 'brain', embedding: 'brain', embeddings: 'brain',
  // devices
  mobile: 'smartphone', ios: 'smartphone', android: 'smartphone', desktop: 'monitor',
  web: 'globe', browser: 'globe',
  // the fine print
  legal: 'scale', license: 'scroll', licensing: 'scroll', terms: 'scroll', policy: 'shield',
  policies: 'shield', gdpr: 'shield', schedule: 'calendar', calendar: 'calendar',
  task: 'list-checks', tasks: 'list-checks', job: 'clock', jobs: 'clock',
};

const normalize = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The icon for a label, or undefined when it says nothing this can read. `kind` is the navigation
 * container the label names, or `page`; only a container falls back to a generic marker.
 */
export function suggestIconName(label: unknown, kind: string, contract = loadContract()): string | undefined {
  if (typeof label !== 'string' || !label.trim()) return undefined;
  const text = normalize(label);
  if (!text) return undefined;
  const drawable = (name: string | undefined): string | undefined => (name && new Set(contract.icons.names).has(name) ? name : undefined);
  // A changelog groups its entries by year, and a bare year says nothing a word list can read.
  if (/^(?:19|20)\d{2}$/.test(text)) return drawable('calendar');
  for (const [phrase, icon] of PHRASES) if (text === phrase || text.includes(phrase)) { const drawn = drawable(icon); if (drawn) return drawn; }
  for (const word of text.split(' ')) { const drawn = drawable(KEYWORDS[word]); if (drawn) return drawn; }
  return kind === 'page' ? undefined : drawable(CONTAINER_FALLBACK[kind]);
}

/** The navigation container kinds, in the order the schema nests them. */
const CONTAINER_KINDS = ['product', 'version', 'language', 'tab', 'dropdown', 'menu', 'group'] as const;
const CHILD_KEYS = ['products', 'versions', 'languages', 'tabs', 'dropdowns', 'menus', 'groups', 'pages'] as const;

const containerKindOf = (node: Record<string, unknown>): string | undefined => CONTAINER_KINDS.find((kind) => typeof node[kind] === 'string');

/**
 * Applies the site plan's icon policy to a built navigation tree.
 *
 * `source` and `none` need no reading of labels: one leaves the tree alone, the other strips every
 * icon. `suggested` fills the gaps — a container that states no icon gets one for its own label, and
 * a container whose pages mostly name something this can read gets one on every page, so no row in
 * it sits with its title shifted against its neighbours'.
 */
export function applyIconPolicy(
  navigation: Record<string, unknown>,
  policy: IconPolicy,
  contract = loadContract(),
): { navigation: Record<string, unknown>; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const accepts = (kind: string, prop: string): boolean => (contract.navigation.containerProps[kind] ?? []).includes(prop);
  const pageAcceptsIcon = contract.navigation.pageProps.includes('icon');

  const visit = (value: unknown, kind: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => visit(item, kind));
    if (!value || typeof value !== 'object') return value;
    const node = { ...(value as Record<string, unknown>) };
    const ownKind = containerKindOf(node) ?? (typeof node.title === 'string' ? 'page' : kind);

    if (policy === 'none') {
      if ('icon' in node) { delete node.icon; removed += 1; }
    } else if (policy === 'suggested' && ownKind !== 'page' && !node.icon && accepts(ownKind, 'icon')) {
      // A container that only links out is a button, not a section; the platform draws it in the
      // bar rather than the sidebar, and an invented marker there is noise.
      const icon = suggestIconName(node[ownKind], ownKind, contract);
      if (icon) { node.icon = icon; added += 1; }
    }

    for (const key of CHILD_KEYS) {
      const children = node[key];
      if (!Array.isArray(children)) continue;
      const childKind = key === 'pages' ? 'page' : key.slice(0, -1);
      node[key] = (visit(children, childKind) as unknown[]);
      if (policy === 'suggested' && key === 'pages' && pageAcceptsIcon) {
        const result = fillPageIcons(node[key] as unknown[], contract);
        node[key] = result.pages;
        added += result.added;
      }
    }
    return node;
  };

  return { navigation: visit(navigation, 'root') as Record<string, unknown>, added, removed };
}

/**
 * Icons for the page rows of one container, all of them or none.
 *
 * A `pages` array may also hold nested groups; those are containers and were handled on the way
 * down, so only the entries with a title are counted and filled here.
 */
function fillPageIcons(pages: unknown[], contract: ReturnType<typeof loadContract>): { pages: unknown[]; added: number } {
  const isPage = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).title === 'string' && !containerKindOf(item as Record<string, unknown>);
  const rows = pages.filter(isPage);
  if (!rows.length) return { pages, added: 0 };
  // A source that states its own icons already decided this container's look; filling the rest
  // would mix its choices with ours on the same rows.
  if (rows.some((row) => typeof row.icon === 'string' && row.icon)) return { pages, added: 0 };
  const named = new Map<Record<string, unknown>, string>();
  for (const row of rows) {
    const icon = suggestIconName(row.title, 'page', contract);
    if (icon) named.set(row, icon);
  }
  if (named.size / rows.length < PAGE_FILL_THRESHOLD) return { pages, added: 0 };
  let added = 0;
  const filled = pages.map((item) => {
    if (!isPage(item)) return item;
    const icon = named.get(item) ?? PAGE_FILLER;
    added += 1;
    return { ...item, icon };
  });
  return { pages: filled, added };
}

/** Every icon name this module can write, for the test that keeps them all drawable. */
export function suggestableIconNames(): string[] {
  return [...new Set([...PHRASES.map(([, icon]) => icon), ...Object.values(KEYWORDS), ...Object.values(CONTAINER_FALLBACK), PAGE_FILLER])];
}

/** Reads an icon a source states, under the name the renderer draws it by. Re-exported so callers need one import. */
export { drawableIconName };
