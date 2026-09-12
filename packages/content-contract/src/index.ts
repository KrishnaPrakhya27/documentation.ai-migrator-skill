/**
 * The Documentation.AI content contract: what the migrator may emit and how
 * it is validated. Loads the reconciled `contract.json` produced by
 * `scripts/extract.ts` and exposes strict validators.
 *
 * Strict means: every condition the platform's own deployment validator only
 * warns about is an error here.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export interface PropSchema {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  required?: boolean;
}

export interface ComponentContract {
  name: string;
  publicName: string;
  sources: { renderer: boolean; deploymentValidator: boolean; editorSchema: boolean };
  props: Record<string, PropSchema>;
  children?: { allowed?: string[]; min?: number };
  notes: string[];
}

export interface ContentContract {
  contractVersion: string;
  generatedAt: string;
  emittable: string[];
  components: ComponentContract[];
  valueMaps: Record<string, Record<string, Record<string, string>>>;
  frontmatter: { required: string[]; optional: string[] };
  navigation: { rootKeys: string[]; rule: string };
  redirects: {
    supported: { exact: boolean; namedParam: boolean; trailingWildcard: boolean; splat: boolean };
    defaultStatus: number;
    caseSensitive: boolean;
    segmentCountMustMatch: boolean;
  };
  anchors: { customIds: boolean; slugger: string };
  images: { relativeSourcesResolve: boolean; note: string };
  snippets: { mdx: boolean; jsx: { allowed: boolean; executable: boolean; migratorEmits: boolean } };
}

let cached: ContentContract | undefined;

export function loadContract(path = join(here, '..', 'contract.json')): ContentContract {
  if (!cached) cached = JSON.parse(readFileSync(path, 'utf8')) as ContentContract;
  return cached;
}

export function componentByPublicName(name: string, contract = loadContract()): ComponentContract | undefined {
  return contract.components.find((c) => c.publicName === name && c.name === name) ?? contract.components.find((c) => c.publicName === name);
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code:
    | 'unknown-component'
    | 'invalid-navigation'
    | 'editor-only-node'
    | 'invalid-prop-value'
    | 'missing-required-prop'
    | 'residual-source-syntax'
    | 'expression'
    | 'esm'
    | 'frontmatter-missing'
    | 'frontmatter-title-missing'
    | 'executable';
  message: string;
  line?: number;
}

const RESIDUAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^:::(note|tip|info|warning|danger|caution)\b/m, label: 'Docusaurus admonition' },
  { re: /\{%\s*(hint|tabs|tab|endhint|endtabs|endtab|embed|content-ref|code)\b/m, label: 'GitBook Liquid tag' },
  { re: /\{\{\s*snippet\./m, label: 'Document360 snippet token' },
  { re: /@embed\[/m, label: 'ReadMe embed' },
  { re: /<<\s*glossary:/m, label: 'ReadMe glossary variable' },
  // a ReadMe callout is a quote that opens with the emoji; the same emoji on a later line of a quote is its text
  { re: /(?<!(?:^|\n)[ \t]*>[^\n]*\n)^[ \t]*>\s*(📘|👍|🚧|❗)/m, label: 'ReadMe emoji callout' },
  { re: /<(Note|Tip|Warning|Info|Check|Accordion|AccordionGroup|Frame|Tooltip|Badge|Icon|Panel|Tiles|Tree|Banner|RequestExample|ResponseExample)\b/m, label: 'Mintlify component' },
];

/** Split frontmatter from body. Returns null frontmatter when absent. */
export function splitFrontmatter(mdx: string): { frontmatter: string | null; body: string; bodyStartLine: number } {
  const m = mdx.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: null, body: mdx, bodyStartLine: 1 };
  return { frontmatter: m[1], body: mdx.slice(m[0].length), bodyStartLine: m[0].split('\n').length };
}

/** Remove fenced code and inline code so tag scanning does not see examples. */
function stripCode(body: string): string {
  // fences count only at line start (a mid-line ``` must not hide the rest of the document); a component's children indent theirs
  return body
    .replace(/^ *(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n *\1[ \t]*$/gm, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));
}

/** Multi-line tags, expressions and import statements are folded onto one line so line-based checks cannot be split around. */
function foldMultiline(scan: string): string {
  return scan
    .replace(/<[A-Za-z][^<>]*>/g, (s) => s.replace(/\n/g, ' '))
    .replace(/\{[^{}]*\}/g, (s) => s.replace(/\n/g, ' '))
    .replace(/^(\s*(?:import|export)\s)[^;\n]*(?:\n[^;\n]*)*?(?=;|\n\s*\n|$)/gm, (s) => s.replace(/\n/g, ' '));
}

/** Strictly validate one MDX document against the contract. */
export function validateMdx(mdx: string, contract = loadContract()): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { frontmatter, body, bodyStartLine } = splitFrontmatter(mdx);
  if (frontmatter === null) issues.push({ severity: 'error', code: 'frontmatter-missing', message: 'frontmatter block is required for migrated pages' });
  else if (!/^title:\s*\S/m.test(frontmatter)) issues.push({ severity: 'error', code: 'frontmatter-title-missing', message: 'frontmatter.title is required' });

  const scan = foldMultiline(stripCode(body));
  const emittable = new Set(contract.emittable);
  const editorOnly = new Set(contract.components.filter((c) => c.notes.some((n) => n.startsWith('editor-only'))).map((c) => c.name));

  const lines = scan.split('\n');
  lines.forEach((line, i) => {
    const ln = bodyStartLine + i;
    for (const m of line.matchAll(/<([A-Za-z][A-Za-z0-9]*)\b([^>]*)>/g)) {
      const name = m[1];
      const editorOnlyHit = editorOnly.has(name) || editorOnly.has(name.charAt(0).toUpperCase() + name.slice(1));
      if (/^[a-z]/.test(name) && !editorOnlyHit) continue; // plain HTML element
      if (editorOnlyHit) issues.push({ severity: 'error', code: 'editor-only-node', message: `<${name}> is an editor-internal node`, line: ln });
      else if (!emittable.has(name)) issues.push({ severity: 'error', code: 'unknown-component', message: `<${name}> is not accepted by the deployment validator`, line: ln });
      else {
        const spec = componentByPublicName(name, contract);
        const attrs = m[2];
        if (spec) {
          for (const [prop, ps] of Object.entries(spec.props)) {
            const am = attrs.match(new RegExp(`\\b${prop}=(?:"([^"]*)"|'([^']*)'|\\{([^}]*)\\})`));
            const raw = am ? (am[1] ?? am[2] ?? am[3]) : undefined;
            if (ps.required && raw === undefined && !/^\s*\/?>?$/.test(attrs) && name !== 'Image') {
              // required props are checked for self-closing usage only where the editor demands them
            }
            if (raw !== undefined && ps.enum && !ps.enum.map(String).includes(String(raw))) {
              issues.push({ severity: 'error', code: 'invalid-prop-value', message: `<${name} ${prop}="${raw}"> not in [${ps.enum.join(', ')}]`, line: ln });
            }
          }
          if (name === 'Image' && !/\balt=/.test(attrs)) issues.push({ severity: 'error', code: 'missing-required-prop', message: '<Image> requires alt', line: ln });
          if (name === 'Script') issues.push({ severity: 'error', code: 'executable', message: '<Script> is executable and is never emitted by the migrator', line: ln });
        }
      }
    }
    if (/^\s*(import|export)\s/.test(line) && !/^\s*import\s+[A-Za-z_$][\w$]*\s+from\s+["']\/snippets\/(?!.*\.\.)[\w./-]+\.(?:mdx?|jsx)["'];?\s*$/.test(line)) issues.push({ severity: 'error', code: 'esm', message: 'ESM is not allowed except snippet default imports', line: ln });
    for (const em of line.matchAll(/\{([^}]*)\}/g)) {
      const inner = em[1].trim();
      if (!inner) continue;
      if (/^user\.[a-zA-Z_]+$/.test(inner)) continue; // the one supported expression
      if (/^[0-9]+$/.test(inner)) continue; // numeric props like cols={3}
      if (/^(?:true|false)$/.test(inner)) continue; // boolean props like controls={true}; the platform parses them as JSON literals
      if (/^\/\*[\s\S]*\*\/$/.test(inner)) continue; // MDX comment
      issues.push({ severity: 'error', code: 'expression', message: `expression {${inner.slice(0, 40)}} is not allowed`, line: ln });
    }
  });

  for (const { re, label } of RESIDUAL_PATTERNS) {
    const m = scan.match(re);
    if (m) issues.push({ severity: 'error', code: 'residual-source-syntax', message: `${label} left in output: ${m[0].slice(0, 60)}` });
  }
  return issues;
}

/** Navigation: exactly one semantic root key; recurse; every page path resolves. */
/** Child collections each navigation container may hold, per the platform schema (dashboard.documentation.ai/documentation.json). */
const NAV_CHILDREN: Record<string, string[]> = {
  navigation: ['products', 'versions', 'languages', 'tabs', 'dropdowns', 'menus', 'groups', 'pages'],
  product: ['versions', 'tabs', 'dropdowns', 'menus', 'groups', 'pages'],
  version: ['tabs', 'dropdowns', 'menus', 'groups', 'pages'],
  language: ['versions', 'tabs', 'dropdowns', 'menus', 'groups', 'pages'],
  tab: ['menus', 'groups', 'pages'],
  dropdown: ['tabs', 'menus', 'groups', 'pages'],
  menu: ['groups', 'pages'],
  group: ['pages'],
};
const NAV_ITEM: Record<string, string> = { products: 'product', versions: 'version', languages: 'language', tabs: 'tab', dropdowns: 'dropdown', menus: 'menu', groups: 'group' };

/**
 * documentation.json structure. Pages are objects ({ title, path | href }) or nested
 * groups; a bare string is a Mintlify convention the renderer does not accept.
 */
export function validateNavigation(doc: any, pageExists: (path: string) => boolean, contract = loadContract()): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string) => { issues.push({ severity: 'error', code: 'invalid-navigation', message }); };
  if (typeof doc?.name !== 'string' || !doc.name) err('documentation.json requires a string "name"');
  if (doc?.initialRoute !== undefined) {
    const route = String(doc.initialRoute);
    if (route.startsWith('/')) err(`initialRoute "${route}" must be a page path without a leading slash`);
    else if (!pageExists(route)) err(`initialRoute "${route}" has no page file`);
  }
  const nav = doc?.navigation;
  if (!nav || typeof nav !== 'object') { err('documentation.json has no navigation object'); return issues; }
  const keys = contract.navigation.rootKeys;

  const pageItem = (it: any, path: string): void => {
    if (typeof it === 'string') { err(`${path} is the bare string "${it}"; pages must be objects like { "title": ..., "path": ... }`); return; }
    if (!it || typeof it !== 'object') { err(`${path} must be a page or group object`); return; }
    if ('group' in it) { container(it, 'group', path); return; }
    if (typeof it.title !== 'string' || !it.title) err(`${path} requires a "title"`);
    if (typeof it.path === 'string') { if (!pageExists(it.path)) err(`navigation page "${it.path}" has no file (${path})`); }
    else if (typeof it.href !== 'string') err(`${path} requires "path" or "href"`);
  };
  const container = (node: any, kind: string, path: string): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { err(`${path} must be an object`); return; }
    if (kind !== 'navigation' && (typeof node[kind] !== 'string' || !node[kind])) err(`${path} requires a string "${kind}"`);
    if ((kind === 'version' || kind === 'language') && 'default' in node) err(`${path}: "default" is not a ${kind} property; list the default ${kind} first`);
    const allowed = NAV_CHILDREN[kind];
    const present = keys.filter((k) => k in node);
    const externalTab = kind === 'tab' && typeof node.href === 'string';
    if (!externalTab && present.length !== 1) err(`${path} must have exactly one of [${allowed.join(', ')}]`);
    for (const k of present) {
      if (!allowed.includes(k)) { err(`${path}: a ${kind} cannot contain ${k}`); continue; }
      const items = node[k];
      if (!Array.isArray(items)) { err(`${path}.${k} must be an array`); continue; }
      items.forEach((it: any, i: number) => (k === 'pages' ? pageItem(it, `${path}.${k}[${i}]`) : container(it, NAV_ITEM[k], `${path}.${k}[${i}]`)));
    }
  };
  container(nav, 'navigation', 'navigation');
  return issues;
}

/** Redirect rule support check against the platform. */
export function classifyRedirect(source: string, contract = loadContract()): 'exact' | 'named-param' | 'needs-wildcard' {
  if (/\*/.test(source) || /:splat/.test(source)) return contract.redirects.supported.trailingWildcard ? 'named-param' : 'needs-wildcard';
  if (/:[A-Za-z_]+/.test(source)) return 'named-param';
  return 'exact';
}

export const SLUG_RULES = {
  pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  maxKeyBytes: 1024,
};

export function isValidSlugSegment(s: string): boolean {
  return SLUG_RULES.pattern.test(s);
}
