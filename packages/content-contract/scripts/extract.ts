/**
 * Initial extraction of the Documentation.AI content contract from the product
 * repositories. This is Phase 0 step 1: it reads current behaviour from three
 * surfaces that disagree and writes `contract.json`, applying the human
 * reconciliation decisions recorded in `decisions.yaml`.
 *
 * After Phase 0 the package is authoritative and the product repos test
 * against it; this script then only exists to detect drift (`--check`).
 *
 * Usage:
 *   tsx packages/content-contract/scripts/extract.ts \
 *     --app /path/documentation-ai-app \
 *     --backend /path/documentation-ai-backend \
 *     --dashboard /path/documentation-ai-dashboard [--check]
 */
import { parseArgs } from 'node:util';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

const { values } = parseArgs({
  options: {
    app: { type: 'string', default: process.env.DAI_APP_REPO ?? '/home/krishna/documentation-ai-app' },
    backend: { type: 'string', default: process.env.DAI_BACKEND_REPO ?? '/home/krishna/documentation-ai-backend' },
    dashboard: { type: 'string', default: process.env.DAI_DASHBOARD_REPO ?? '/home/krishna/documentation-ai-dashboard' },
    check: { type: 'boolean', default: false },
  },
});

interface PropSchema {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  required?: boolean;
}

interface ComponentContract {
  name: string;
  /** Which product surfaces know this name. */
  sources: { renderer: boolean; deploymentValidator: boolean; editorSchema: boolean };
  /** Canonical public MDX name. Names that only exist in the editor map to another public name. */
  publicName: string;
  props: Record<string, PropSchema>;
  /** Child rules from the editor schema, when present. */
  children?: { allowed?: string[]; min?: number };
  /** Reconciliation notes. */
  notes: string[];
}

interface Decisions {
  version: string;
  aliases: Record<string, string>;
  propOverrides: Record<string, Record<string, PropSchema>>;
  valueMaps: Record<string, Record<string, Record<string, string>>>;
  editorOnly: string[];
  notes: Record<string, string>;
}

function readText(p: string): string {
  return readFileSync(p, 'utf8');
}

/** Renderer: PascalCase keys of `defaultComponents` in MDXRemoteServer.tsx. */
function extractRendererComponents(appRepo: string): string[] {
  const src = readText(join(appRepo, 'src/components/mdx-components/MDXRemoteServer.tsx'));
  const start = src.indexOf('const defaultComponents = {');
  const end = src.indexOf('};', start);
  const body = src.slice(start, end);
  const names = new Set<string>();
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*(?::|,|$)/);
    if (m && /^[A-Z]/.test(m[1])) names.add(m[1]);
  }
  return [...names].sort();
}

/** Deployment validator: entries of ALLOWED_CUSTOM_COMPONENTS. */
function extractValidatorAllowlist(backendRepo: string): string[] {
  const src = readText(join(backendRepo, 'src/trigger/services/deployment/mdxValidation.service.ts'));
  const start = src.indexOf('ALLOWED_CUSTOM_COMPONENTS = new Set([');
  const end = src.indexOf(']);', start);
  const body = src.slice(start, end);
  return [...body.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]).sort();
}

/** Editor: UCC JSON schemas; title = component name, properties = props. */
function extractEditorSchemas(dashboardRepo: string): Record<string, { props: Record<string, PropSchema>; children?: { allowed?: string[]; min?: number } }> {
  const dir = join(dashboardRepo, 'src/components/ucc');
  const out: Record<string, { props: Record<string, PropSchema>; children?: { allowed?: string[]; min?: number } }> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const schema = JSON.parse(readText(join(dir, f)));
    const name: string = schema.title;
    const props: Record<string, PropSchema> = {};
    const required = new Set<string>(schema.required ?? []);
    for (const [k, v] of Object.entries<any>(schema.properties ?? {})) {
      if (k === 'type' || k === 'uid' || k === 'children') continue;
      props[k] = {
        type: v.type,
        enum: v.enum,
        default: v.default,
        description: v.description,
        required: required.has(k),
      };
    }
    let children: { allowed?: string[]; min?: number } | undefined;
    const ch = schema.properties?.children;
    if (ch) {
      const refs: string[] = [];
      const items = ch.items;
      if (items?.$ref?.endsWith('.json')) refs.push(items.$ref.replace('.json', ''));
      const block = schema.$defs?.block?.oneOf ?? [];
      for (const b of block) if (b.$ref?.endsWith('.json')) refs.push(b.$ref.replace('.json', ''));
      children = { allowed: refs.length ? refs : undefined, min: ch.minItems };
    }
    out[name] = { props, children };
  }
  return out;
}

function main() {
  const decisions = parseYaml(readText(join(pkgRoot, 'decisions.yaml'))) as Decisions;
  const renderer = new Set(extractRendererComponents(values.app!));
  const validator = new Set(extractValidatorAllowlist(values.backend!));
  const editor = extractEditorSchemas(values.dashboard!);

  const allNames = new Set<string>([...renderer, ...validator, ...Object.keys(editor)]);
  const components: ComponentContract[] = [];

  for (const name of [...allNames].sort()) {
    const inRenderer = renderer.has(name);
    const inValidator = validator.has(name);
    const inEditor = name in editor;
    const publicName = decisions.aliases[name] ?? name;
    const notes: string[] = [];
    if (decisions.editorOnly.includes(name)) notes.push('editor-only node; never emitted by the migrator');
    if (publicName !== name) notes.push(`alias of ${publicName} (decision)`);
    if (inRenderer && !inValidator) notes.push('renderer knows it but the deployment validator would reject it');
    if (inValidator && !inRenderer) notes.push('validator allows it but the renderer has no component');
    if (decisions.notes[name]) notes.push(decisions.notes[name]);

    const props: Record<string, PropSchema> = { ...(editor[name]?.props ?? {}) };
    for (const [k, v] of Object.entries(decisions.propOverrides[name] ?? {})) props[k] = { ...(props[k] ?? {}), ...v };

    components.push({
      name,
      publicName,
      sources: { renderer: inRenderer, deploymentValidator: inValidator, editorSchema: inEditor },
      props,
      children: editor[name]?.children,
      notes,
    });
  }

  /** Emittable = public names the deployment validator accepts (after aliasing). */
  const emittable = [...new Set(components.map((c) => c.publicName))]
    .filter((n) => validator.has(n) || ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'pre', 'blockquote', 'a'].includes(n))
    .sort();

  const contract = {
    contractVersion: decisions.version,
    generatedAt: new Date().toISOString(),
    inputs: {
      renderer: 'documentation-ai-app/src/components/mdx-components/MDXRemoteServer.tsx',
      deploymentValidator: 'documentation-ai-backend/src/trigger/services/deployment/mdxValidation.service.ts',
      editorSchemas: 'documentation-ai-dashboard/src/components/ucc/*.json',
    },
    emittable,
    components,
    valueMaps: decisions.valueMaps,
    frontmatter: {
      required: ['title'],
      optional: ['description', 'metaTitle', 'metaDescription', 'ogImage', 'canonical', 'jsonLd'],
    },
    navigation: {
      // hand-written from the published schema, not extracted from the renderer
      rootKeys: ['products', 'versions', 'languages', 'tabs', 'dropdowns', 'menus', 'groups', 'pages'],
      rule: 'exactly one child collection per container, nested in schema order products > versions > languages > tabs > dropdowns > groups > pages; pages are objects { title, path | href } or nested groups, never bare strings (schema: dashboard.documentation.ai/documentation.json)',
    },
    redirects: {
      supported: { exact: true, namedParam: true, trailingWildcard: false, splat: false },
      defaultStatus: 308,
      caseSensitive: true,
      segmentCountMustMatch: true,
    },
    anchors: { customIds: false, slugger: 'rehype-slug (github-slugger), dashes collapsed' },
    images: { relativeSourcesResolve: false, note: 'loader accepts relative paths but deployment uploads no repo assets; use ingested absolute URLs' },
    snippets: { mdx: true, jsx: { allowed: true, executable: true, migratorEmits: false } },
  };

  const outPath = join(pkgRoot, 'contract.json');
  const next = JSON.stringify(contract, null, 2) + '\n';
  if (values.check) {
    if (!existsSync(outPath)) throw new Error('contract.json missing');
    const prev = JSON.parse(readText(outPath));
    const strip = (c: any) => JSON.stringify({ ...c, generatedAt: undefined });
    if (strip(prev) !== strip(contract)) {
      console.error('Contract drift detected between product repos and contract.json');
      process.exit(1);
    }
    console.log('contract in sync');
    return;
  }
  writeFileSync(outPath, next);
  console.log(`wrote ${outPath}: ${components.length} components, ${emittable.length} emittable`);
}

main();
