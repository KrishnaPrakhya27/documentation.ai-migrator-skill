/**
 * Custom component definitions in a source repository. A definition's hash
 * becomes part of the component signature, so two customers' "FeatureGrid"
 * components cluster separately and a reviewed static port applies only to
 * the definition it was reviewed against.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DocIR } from '../ir/types.js';
import { walkBlocks } from '../ir/types.js';
import { shortHash } from '../session/ids.js';

export interface ComponentDefinition { name: string; file: string; hash: string; exports: string[] }

const DEF_DIRS = ['snippets', 'components', 'src/components', 'custom-blocks', 'custom-components', 'theme'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, out); }
    else if (/\.(?:jsx?|tsx?)$/.test(e.name) && !/\.(?:test|spec)\./.test(e.name)) out.push(p);
  }
  return out;
}

export function scanComponentDefinitions(rootIn: string): ComponentDefinition[] {
  const root = resolve(rootIn);
  const files: string[] = [];
  for (const d of DEF_DIRS) { const p = join(root, d); try { if (statSync(p).isDirectory()) walk(p, files); } catch { /* absent */ } }
  const out: ComponentDefinition[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const exports = new Set<string>();
    for (const m of src.matchAll(/export\s+(?:const|let|function|class)\s+([A-Z][A-Za-z0-9_]*)/g)) exports.add(m[1]);
    for (const m of src.matchAll(/export\s+default\s+(?:function|class)\s+([A-Z][A-Za-z0-9_]*)/g)) exports.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) for (const n of m[1].split(',')) { const name = n.trim().split(/\s+as\s+/).pop()!; if (/^[A-Z]/.test(name)) exports.add(name); }
    if (!exports.size) continue;
    const hash = shortHash(src, 16);
    for (const name of exports) out.push({ name, file: f.slice(root.length + 1), hash, exports: [...exports] });
  }
  return out;
}

/** Attach definition hashes to source components whose name matches a definition. */
export function attachDefinitions(doc: DocIR, defs: ComponentDefinition[]): DocIR {
  if (!defs.length) return doc;
  const byName = new Map(defs.map((d) => [d.name, d]));
  walkBlocks(doc.children, (n) => {
    if (n.type === 'component') { const d = byName.get(n.name); if (d) n.definition = { file: d.file, hash: d.hash }; }
  });
  return doc;
}
