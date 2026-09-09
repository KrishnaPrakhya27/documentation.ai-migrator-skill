/**
 * Component signatures and clustering. A signature is not Component(propNames):
 * it includes platform, prop types and significant value buckets, child
 * topology, nesting depth, style dependencies and a definition hash.
 */
import type { ComponentNode, Block } from '../ir/types.js';
import { shortHash } from '../session/ids.js';

export interface Signature {
  hash: string;
  platform: string;
  name: string;
  props: Record<string, string>;
  children: string[];
  depth: number;
  styleDeps: string[];
  definitionHash?: string;
}

function bucket(v: string | number | boolean | null): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  const s = String(v);
  if (/^https?:\/\//.test(s)) return 'url';
  if (/^[a-z][a-z0-9_-]{0,24}$/.test(s)) return `enum:${s}`; // short token-like values are significant (kinds, themes)
  if (s.length <= 40) return 'string:short';
  return 'string:long';
}

function topology(children: Block[], depth = 0): string[] {
  if (depth > 1) return [];
  const kinds = new Set<string>();
  for (const c of children) {
    if (c.type === 'component') kinds.add(`component:${c.name}`);
    else if (c.type === 'dai') kinds.add(`dai:${c.name}`);
    else kinds.add(c.type);
    if ('children' in c && Array.isArray((c as any).children) && c.type !== 'paragraph' && c.type !== 'heading' && c.type !== 'table') {
      for (const k of topology((c as any).children, depth + 1)) kinds.add(`>${k}`);
    }
  }
  return [...kinds].sort();
}

export function signatureOf(node: ComponentNode, depth = 0): Signature {
  const props: Record<string, string> = {};
  for (const k of Object.keys(node.props).sort()) props[k] = bucket(node.props[k]);
  const styleDeps = [...(node.styleDeps ?? [])].sort();
  const sig: Omit<Signature, 'hash'> = {
    platform: node.platform,
    name: node.name,
    props,
    children: topology(node.children),
    depth,
    styleDeps,
    definitionHash: node.definition?.hash,
  };
  return { hash: shortHash(JSON.stringify(sig), 12), ...sig };
}

export interface ClusterEntry {
  cluster: string;
  signature: Signature;
  count: number;
  samples: Array<{ pageId: string; nodeId: string; source?: string }>;
  definitionFound: boolean;
}

export function clusterComponents(items: Array<{ pageId: string; node: ComponentNode; depth: number; source?: string }>, maxSamples = 5): ClusterEntry[] {
  const map = new Map<string, ClusterEntry>();
  for (const it of items) {
    const sig = signatureOf(it.node, it.depth);
    let e = map.get(sig.hash);
    if (!e) { e = { cluster: `${it.node.platform}/${it.node.name}#${sig.hash.slice(0, 6)}`, signature: sig, count: 0, samples: [], definitionFound: !!it.node.definition }; map.set(sig.hash, e); }
    e.count++;
    if (e.samples.length < maxSamples) e.samples.push({ pageId: it.pageId, nodeId: it.node.id, source: it.source });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
