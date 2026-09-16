/**
 * A Mintlify endpoint page, read as the operation it documents.
 *
 * Mintlify renders an endpoint page from a spec: the source file is prose plus a frontmatter line
 * `openapi: <spec> METHOD /path`, and the page shows the parameters, responses and playground the
 * spec describes. Its published Markdown restates that as a trailing "## OpenAPI" section holding
 * a fence whose info string names the spec and operation, and whose body is the spec cut down to
 * that one operation. Carried across as a code block, the migrated page showed a reader YAML where
 * the source showed them an API reference.
 *
 * Documentation.AI renders the same page the same way from `openapi: api-reference/<spec> METHOD
 * /path` in the frontmatter, with the spec file under `api-reference/`. So the section is read
 * back into the statement it came from: the frontmatter names the operation, the fence's spec is
 * kept to assemble the file, and the section itself — the platform's rendering, not the author's
 * words — leaves the body. Every page's fragment carries one operation; put together, the
 * fragments of one spec are every operation the site documented from it.
 */
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { inlineText, type Block, type OpenApiOperationFragment } from './types.js';

const OPERATION_INFO = /^(\S+)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\S+)$/i;

/** The trailing OpenAPI section, split from the page it ends; undefined when the page has none. */
export function mintlifyOperationSection(children: Block[]): { children: Block[]; operation: OpenApiOperationFragment } | undefined {
  // The export writes the section near the end, but may follow it with a "Related topics" list; it
  // is found by its shape, searching from the end, rather than assumed to be the last two blocks.
  for (let at = children.length - 2; at >= 0; at--) {
    const heading = children[at];
    const code = children[at + 1];
    if (heading.type !== 'heading' || heading.depth !== 2 || inlineText(heading.children).trim() !== 'OpenAPI') continue;
    if (code.type !== 'code' || !/^(?:ya?ml|json)$/i.test(code.lang ?? '')) continue;
    const info = OPERATION_INFO.exec((code.meta ?? '').trim());
    if (!info) continue;
    return {
      children: [...children.slice(0, at), ...children.slice(at + 2)],
      operation: { spec: info[1].replace(/^\.?\/+/, ''), method: info[2].toUpperCase(), path: info[3], document: code.value },
    };
  }
  return undefined;
}

/** The frontmatter value the platform reads: the spec under `api-reference/`, then the operation. */
export function operationFrontmatter(operation: OpenApiOperationFragment): string {
  return `api-reference/${operation.spec} ${operation.method} ${operation.path}`;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One document per spec, assembled from the fragments the pages carried, keyed by the spec's path.
 *
 * Each fragment holds its own operation and the components it references. The union is every
 * operation the site documented from that spec, with the document's own metadata from the first
 * fragment read. Assembly is deterministic: fragments are taken in spec, path and method order,
 * and where two fragments both define a component the first one stands.
 */
export function mergeOperationDocuments(operations: readonly OpenApiOperationFragment[]): Map<string, string> {
  const sorted = [...operations].sort((a, b) => a.spec.localeCompare(b.spec) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const specs = new Map<string, { base: Json; paths: Record<string, Json>; components: Record<string, Json> }>();
  for (const operation of sorted) {
    const document = parseYaml(operation.document) as unknown;
    if (!isObject(document)) throw new Error(`${operation.spec}: the OpenAPI document for ${operation.method} ${operation.path} does not parse as a document`);
    const entry = specs.get(operation.spec) ?? { base: {}, paths: {}, components: {} };
    for (const [key, value] of Object.entries(document)) {
      if (key === 'paths' || key === 'components') continue;
      if (!(key in entry.base)) entry.base[key] = value;
    }
    if (isObject(document.paths)) {
      for (const [path, item] of Object.entries(document.paths)) {
        if (isObject(item)) entry.paths[path] = { ...(entry.paths[path] ?? {}), ...item };
      }
    }
    if (isObject(document.components)) {
      for (const [kind, members] of Object.entries(document.components)) {
        if (isObject(members)) entry.components[kind] = { ...members, ...(entry.components[kind] ?? {}) };
      }
    }
    specs.set(operation.spec, entry);
  }
  const out = new Map<string, string>();
  for (const [spec, entry] of specs) {
    const document: Json = { ...entry.base, paths: entry.paths, ...(Object.keys(entry.components).length ? { components: entry.components } : {}) };
    out.set(spec, /\.json$/i.test(spec) ? `${JSON.stringify(document, null, 2)}\n` : toYaml(document, { lineWidth: 0 }));
  }
  return out;
}

/**
 * The anchors the platform renders for an operation's parameters, from the spec that documents it.
 *
 * Documentation.AI gives every rendered parameter the id `<location>-<name>` — `query-cursor`,
 * `body-projectId` — where the location is where the parameter is sent. Mintlify wrote the same
 * link as `#param-<name>` for every location, so a deep link into an endpoint page follows the
 * parameter to the id the platform gives it, and the fragment gate can see that it lands.
 */
export function openapiAnchors(documentText: string, method: string, path: string): Set<string> {
  const anchors = new Set<string>();
  let document: unknown;
  try { document = parseYaml(documentText); } catch { return anchors; }
  if (!isObject(document)) return anchors;
  const paths = isObject(document.paths) ? document.paths : {};
  const item: Json | undefined = isObject(paths[path]) ? (paths[path] as Json) : undefined;
  const operation: Json | undefined = item && isObject(item[method.toLowerCase()]) ? (item[method.toLowerCase()] as Json) : undefined;
  if (!item || !operation) return anchors;
  const components = isObject(document.components) ? document.components : {};
  const deref = (value: unknown): Json | undefined => {
    if (!isObject(value)) return undefined;
    if (typeof value.$ref !== 'string') return value;
    const [, kind, name] = /^#\/components\/(\w+)\/(.+)$/.exec(value.$ref) ?? [];
    const members = kind && isObject(components[kind]) ? components[kind] : undefined;
    return members && isObject(members[name]) ? members[name] : undefined;
  };
  const parameters = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  for (const raw of parameters) {
    const parameter = deref(raw);
    if (parameter && typeof parameter.name === 'string' && typeof parameter.in === 'string') anchors.add(`${parameter.in}-${parameter.name}`);
  }
  const body = deref(operation.requestBody);
  const content = body && isObject(body.content) ? Object.values(body.content)[0] : undefined;
  const schema = isObject(content) ? deref(content.schema) : undefined;
  if (schema && isObject(schema.properties)) for (const name of Object.keys(schema.properties)) anchors.add(`body-${name}`);
  return anchors;
}

/** `spec METHOD /path`, as the frontmatter states it. */
export function parseOperationFrontmatter(value: unknown): { spec: string; method: string; path: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(\S+)\s+(\w+)\s+(\S+)$/.exec(value.trim());
  return m ? { spec: m[1], method: m[2].toUpperCase(), path: m[3] } : undefined;
}

/**
 * A link rewriter that follows a `#param-<name>` fragment on an endpoint page to the anchor the
 * platform renders for that parameter. Anything it cannot place is left exactly as it was, so the
 * fragment gate reports it rather than a rewrite hiding it.
 */
export function parameterLinkRewriter(anchorsByRoute: ReadonlyMap<string, ReadonlySet<string>>): (url: string) => string {
  return (url) => {
    const hash = url.indexOf('#');
    if (hash < 0) return url;
    const match = /^param-(.+)$/.exec(url.slice(hash + 1));
    if (!match) return url;
    const route = url.slice(0, hash).replace(/^\/+/, '').replace(/\/$/, '');
    const anchors = anchorsByRoute.get(route);
    if (!anchors) return url;
    const found = ['path', 'query', 'header', 'body'].map((location) => `${location}-${match[1]}`).find((anchor) => anchors.has(anchor));
    return found ? `${url.slice(0, hash)}#${found}` : url;
  };
}
