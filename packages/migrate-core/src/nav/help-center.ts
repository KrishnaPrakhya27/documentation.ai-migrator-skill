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
export interface HelpCenterHub { nodePath: string; hubPath: string }

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
  const matched: Array<{ trail: string; container: Record<string, unknown> }> = [];
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
        if (label === decision.container) matched.push({ trail: here.join('/'), container });
        else find(container, here);
      }
    }
  };
  find(navigation, []);
  if (!matched.length) throw new Error(`no navigation container is labelled "${decision.container}"; the containers are: ${labels.join(', ') || '(none)'}`);
  const hubs = matched.map(({ trail, container }) => ({
    nodePath: trail,
    hubPath: decision.hubPath && matched.length === 1 ? decision.hubPath : hubPathFor(container, decision.container),
  }));
  const byNodePath = new Map(hubs.map((hub) => [hub.nodePath, hub.hubPath]));
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
        const hubPath = byNodePath.get(here);
        return hubPath ? { ...container, path: hubPath } : visit(container, [...trail, `${key}:${label}`]);
      }) };
    }
    return out;
  };
  return { navigation: visit(navigation, []), hubs };
}

/** The default route for a container's hub: its own label as a directory, with an index. */
export function defaultHubPath(container: string): string {
  return `${slugify(container)}/index`;
}

/** The hub page: the container's label, and the component that renders its categories. */
export function helpCenterHubMdx(decision: Pick<HelpCenterDecision, 'container'>, nodePath: string): string {
  const title = decision.container.replace(/"/g, '\\"');
  return `---\ntitle: "${title}"\n---\n\n<CollectionList node="${nodePath.replace(/"/g, '&quot;')}" layout="cards" cols={2} />\n`;
}
