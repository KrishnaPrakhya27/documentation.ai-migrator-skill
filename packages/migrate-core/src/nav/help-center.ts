/**
 * A help centre, rendered the way the platform renders one.
 *
 * Documentation.AI's help-centre pattern is a container whose landing page is a hub: category
 * cards the reader clicks into, drawn from the navigation itself by `<CollectionList>`. A source
 * that is a help centre — a knowledge base, a learning site, a support section — migrated as
 * plain topic pages reads as product documentation, which is not what its readers had.
 *
 * The migration writes no words. The hub page carries the container's own label as its title and
 * one dynamic component that renders the container's categories; nothing in it is prose the
 * migrator authored. It is still a page the source never had, so it is an operator's decision,
 * recorded with the person who made it, applied identically at `nav` and at verification.
 *
 * How the hub looks is presentation, and follows the platform's own help-centre convention (its
 * starter kit's): the container carries the help icon when the source gives it none, its sections
 * are flat headers rather than accordions, and the hub opens wide with no table of contents,
 * previous/next links or feedback prompt — a front door, not an article.
 */
import { slugify } from '../urls/slugger.js';

export interface HelpCenterDecision {
  /** Label of the container the operator declared a help centre, exactly as the source states it. */
  container: string;
  /**
   * Route of the hub page, when the operator named one. Left out, each matching container opens at
   * the head of its own pages, which is how a section published per language gets one hub each.
   */
  hubPath?: string;
  approvedBy: string;
  approvedAt: string;
}

const CONTAINER_KEYS = ['products', 'versions', 'languages', 'tabs', 'dropdowns', 'menus', 'groups'] as const;
const LABEL_OF: Record<string, string> = { products: 'product', versions: 'version', languages: 'language', tabs: 'tab', dropdowns: 'dropdown', menus: 'menu', groups: 'group' };

/**
 * The navigation with the container opening on its hub, and the node path `<CollectionList>`
 * addresses that container by (`tabs:Help center`, or `languages:en/tabs:Help center`).
 *
 * Only a container that exists is changed; naming one the navigation does not hold is an error
 * that lists what it does hold, because guessing a container would place the hub somewhere the
 * operator never looked.
 */
export interface HelpCenterHub {
  /** The container, as `<CollectionList>` addresses it. */
  nodePath: string;
  hubPath: string;
  /** The container's own label: a translated help centre is titled in its own language. */
  label: string;
  /** What the hub lists: the container's children, or — when all it holds is one group — that group's, so the hub shows articles rather than one card. */
  listNode: string;
  cols: number;
}

/** Every route named beneath a navigation node, so a container's hub can sit where its own pages sit. */
function routesUnder(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) { for (const item of node) routesUnder(item, out); return out; }
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  if (typeof record.path === 'string') out.push(record.path);
  for (const value of Object.values(record)) if (Array.isArray(value)) routesUnder(value, out);
  return out;
}

/**
 * The hub route for one container: the directory its own pages sit in, with an index. A site that
 * publishes its help centre per language states `/docs/help-center/` and `/docs/fr/help-center/`,
 * and each hub belongs at the head of its own, not at a route outside the site's own paths.
 */
function hubPathFor(container: Record<string, unknown>, label: string): string {
  // the directory its pages sit in, not one of the pages: a container of one page is still a section
  const directories = routesUnder(container).map((route) => route.split('/').slice(0, -1));
  if (!directories.length) return defaultHubPath(label);
  const [first] = directories;
  let shared = first.length;
  for (const segments of directories) {
    let count = 0;
    while (count < shared && count < segments.length && segments[count] === first[count]) count++;
    shared = count;
  }
  return shared ? `${first.slice(0, shared).join('/')}/index` : defaultHubPath(label);
}

/**
 * The navigation with the container opening on its hub, and the node path `<CollectionList>`
 * addresses that container by (`tabs:Help center`, or `languages:en/tabs:Help center`).
 *
 * Only a container that exists is changed; naming one the navigation does not hold is an error
 * that lists what it does hold, because guessing a container would place the hub somewhere the
 * operator never looked.
 *
 * A site states the same section once per language, so every container carrying the label opens on
 * a hub of its own, drawn from its own navigation and routed where its own pages sit. Opening one
 * language's help centre and leaving the others as bare topic lists is not the decision the
 * operator made. An explicit --hub-path names the route for a label only one container carries.
 */
export function attachHelpCenterHub(navigation: Record<string, unknown>, decision: Pick<HelpCenterDecision, 'container'> & { hubPath?: string }): { navigation: Record<string, unknown>; hubs: HelpCenterHub[] } {
  const labels: string[] = [];
  interface Found { trail: string[]; key: string; label: string; container: Record<string, unknown> }
  const all: Found[] = [];
  const find = (node: Record<string, unknown>, trail: string[]): void => {
    for (const key of CONTAINER_KEYS) {
      const items = node[key];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const container = item as Record<string, unknown>;
        const label = container[LABEL_OF[key]];
        if (typeof label !== 'string') continue;
        const here = [...trail, `${key}:${label}`];
        labels.push(here.join('/'));
        all.push({ trail: here, key, label, container });
        find(container, here);
      }
    }
  };
  find(navigation, []);
  // By the label as written; failing that, by the label as a slug. A decision recorded when a build
  // named the container from a folder ("help center") still finds it once the navigation carries the
  // source's own spelling ("Help center") — the same container, which is what the person chose.
  const exactly = all.filter((found) => found.label === decision.container);
  const named = exactly.length ? exactly : all.filter((found) => slugify(found.label) === slugify(decision.container));
  // a container inside another match is that match's content, not a second help centre
  const outermost = named.filter((found) => !named.some((other) => other !== found && found.trail.length > other.trail.length && other.trail.every((segment, index) => found.trail[index] === segment)));
  if (!outermost.length) throw new Error(`no navigation container is labelled "${decision.container}"; the containers are: ${labels.join(', ') || '(none)'}`);

  // A site states the same section once per language, under that language's own name for it: "Help
  // center", "Centre d'aide", "帮助中心". The label cannot find those, but the routes can: the same
  // kind of container, in another language, whose pages sit in the same directory once each
  // language's own route prefix is set aside (`docs/help-center` and `docs/fr/help-center`).
  const languageOf = (found: Found): Found | undefined => all.find((other) => other.key === 'languages' && other.trail.length < found.trail.length && other.trail.every((segment, index) => found.trail[index] === segment));
  const directoryOf = (container: Record<string, unknown>): string[] | undefined => {
    const directories = routesUnder(container).map((route) => route.split('/').slice(0, -1));
    if (!directories.length) return undefined;
    const [first] = directories;
    let shared = first.length;
    for (const segments of directories) { let count = 0; while (count < shared && count < segments.length && segments[count] === first[count]) count++; shared = count; }
    return first.slice(0, shared);
  };
  // A language's own root is what all its routes share: `docs` for the default language, whose home
  // page is `docs` itself, and `docs/fr` for French. (The directories they sit in share less: the
  // home page sits in none.)
  const rootOf = (container: Record<string, unknown>): string[] => {
    const routes = routesUnder(container).map((route) => route.split('/'));
    if (!routes.length) return [];
    let shared = routes[0].length;
    for (const segments of routes) { let count = 0; while (count < shared && count < segments.length && segments[count] === routes[0][count]) count++; shared = count; }
    return routes[0].slice(0, shared);
  };
  const withinLanguage = (found: Found): string | undefined => {
    const language = languageOf(found);
    const own = directoryOf(found.container);
    if (!language || !own) return undefined;
    const prefix = rootOf(language.container);
    return prefix.every((segment, index) => own[index] === segment) ? own.slice(prefix.length).join('/') : undefined;
  };
  const matched = [...outermost];
  for (const original of outermost) {
    const relative = withinLanguage(original);
    const language = languageOf(original);
    if (!relative || !language) continue;
    for (const candidate of all) {
      if (matched.includes(candidate) || candidate.key !== original.key || candidate.trail.length !== original.trail.length) continue;
      const theirs = languageOf(candidate);
      if (!theirs || theirs === language) continue;
      if (withinLanguage(candidate) === relative) matched.push(candidate);
    }
  }
  matched.sort((a, b) => all.indexOf(a) - all.indexOf(b));

  const hubs = matched.map((found): HelpCenterHub => {
    const nodePath = found.trail.join('/');
    // All the container holds is one group: the hub lists that group's articles, not a single card.
    const childKey = CONTAINER_KEYS.find((key) => Array.isArray(found.container[key]));
    const only = childKey && (found.container[childKey] as unknown[]).length === 1 ? (found.container[childKey] as Array<Record<string, unknown>>)[0] : undefined;
    const onlyLabel = only && childKey ? only[LABEL_OF[childKey]] : undefined;
    const listed = typeof onlyLabel === 'string' ? only! : found.container;
    const listNode = typeof onlyLabel === 'string' ? `${nodePath}/${childKey}:${onlyLabel}` : nodePath;
    const entries = [...CONTAINER_KEYS, 'pages' as const].reduce((count, key) => count + (Array.isArray(listed[key]) ? (listed[key] as unknown[]).length : 0), 0);
    return {
      nodePath,
      hubPath: decision.hubPath && matched.length === 1 ? decision.hubPath : hubPathFor(found.container, found.label),
      label: found.label,
      listNode,
      cols: entries >= 6 ? 3 : 2,
    };
  });
  const byNodePath = new Map(hubs.map((hub) => [hub.nodePath, hub]));
  /** The platform's help-centre convention: sections are flat headers, not accordions. */
  const flatSections = (container: Record<string, unknown>): Record<string, unknown> => {
    const groups = container.groups;
    if (!Array.isArray(groups)) return container;
    return { ...container, groups: groups.map((group) => (group && typeof group === 'object' && !('expandable' in (group as object)) ? { ...(group as Record<string, unknown>), expandable: false } : group)) };
  };
  const visit = (node: Record<string, unknown>, trail: string[]): Record<string, unknown> => {
    let out = node;
    for (const key of CONTAINER_KEYS) {
      const items = node[key];
      if (!Array.isArray(items)) continue;
      out = { ...out, [key]: items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const container = item as Record<string, unknown>;
        const label = container[LABEL_OF[key]];
        if (typeof label !== 'string') return item;
        const here = [...trail, `${key}:${label}`].join('/');
        const hub = byNodePath.get(here);
        if (!hub) return visit(container, [...trail, `${key}:${label}`]);
        return { ...flatSections(container), ...(typeof container.icon === 'string' ? {} : { icon: HELP_ICON }), path: hub.hubPath, ...HUB_LAYOUT };
      }) };
    }
    return out;
  };
  return { navigation: visit(navigation, []), hubs };
}

/** The icon the platform's own help centres carry. Written only where the source states none. */
const HELP_ICON = 'circle-help';
/** A hub is a front door: wide, with no table of contents, previous/next links or feedback prompt. The deploy copies these from a container onto the page it opens. */
const HUB_LAYOUT = { 'show-toc': false, 'show-page-navigation': false, 'ask-feedback': false, 'content-width': 'wide' } as const;

/** The default route for a container's hub: its own label as a directory, with an index. */
export function defaultHubPath(container: string): string {
  return `${slugify(container)}/index`;
}

/** The hub page: the container's own label, and the component that renders what it holds. No prose. */
export function helpCenterHubMdx(hub: Pick<HelpCenterHub, 'label' | 'listNode' | 'cols'>): string {
  const title = hub.label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `---\ntitle: "${title}"\n---\n\n<CollectionList node="${hub.listNode.replace(/"/g, '&quot;')}" layout="cards" cols={${hub.cols}} />\n`;
}
