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
  /** Route of the hub page the migration writes, without extension. */
  hubPath: string;
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
export function attachHelpCenterHub(navigation: Record<string, unknown>, decision: Pick<HelpCenterDecision, 'container' | 'hubPath'>): { navigation: Record<string, unknown>; nodePath: string } {
  const labels: string[] = [];
  let found: string | undefined;
  const visit = (node: Record<string, unknown>, trail: string[]): Record<string, unknown> => {
    let out = node;
    for (const key of CONTAINER_KEYS) {
      const items = node[key];
      if (!Array.isArray(items)) continue;
      const next = items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const container = item as Record<string, unknown>;
        const label = container[LABEL_OF[key]];
        if (typeof label !== 'string') return item;
        const here = [...trail, `${key}:${label}`];
        labels.push(here.join('/'));
        if (!found && label === decision.container) { found = here.join('/'); return { ...container, path: decision.hubPath }; }
        return visit(container, here);
      });
      out = { ...out, [key]: next };
    }
    return out;
  };
  const result = visit(navigation, []);
  if (!found) throw new Error(`no navigation container is labelled "${decision.container}"; the containers are: ${labels.join(', ') || '(none)'}`);
  return { navigation: result, nodePath: found };
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
