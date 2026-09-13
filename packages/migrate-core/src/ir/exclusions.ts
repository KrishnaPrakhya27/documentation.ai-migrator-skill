/**
 * Operator-approved block exclusions. plan/block-exclusions.yaml names single
 * source nodes, by page id and node id, that must not reach the output.
 * Component clusters are excluded through the component plan; this covers
 * plain blocks (an image, a stray paragraph) that have no cluster to decide on.
 *
 * Every removed node is recorded as `excluded` with its reason and reviewer, so
 * ledger coverage still proves the removal was a decision. The prose, code and
 * table gates compare against the unexcluded snapshot, so excluding a block that
 * carries text fails them, exactly as a component exclusion would.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Block, DocIR } from './types.js';
import { isBlockWithChildren, walkBlocks } from './types.js';
import type { Ledger } from '../ledger/dispositions.js';

export interface BlockExclusion { pageId: string; nodeId: string; reason: string; reviewer: string }

export function blockExclusionsPath(workspace: string): string {
  return join(workspace, 'plan', 'block-exclusions.yaml');
}

export function readBlockExclusions(workspace: string): BlockExclusion[] {
  const p = blockExclusionsPath(workspace);
  if (!existsSync(p)) return [];
  const list = (parseYaml(readFileSync(p, 'utf8')) as { exclusions?: BlockExclusion[] } | null)?.exclusions ?? [];
  for (const e of list) {
    if (!e?.pageId || !e.nodeId || !e.reason || !e.reviewer) throw new Error(`block exclusion needs pageId, nodeId, reason and reviewer: ${JSON.stringify(e)}`);
  }
  return list;
}

/** Exclusions whose node is not in the snapshot: a typo must fail, not silently keep the block. */
export function unmatchedBlockExclusions(docs: Iterable<DocIR>, exclusions: BlockExclusion[]): BlockExclusion[] {
  const present = new Set<string>();
  for (const d of docs) walkBlocks(d.children, (n) => { present.add(`${d.pageId}::${n.id}`); });
  return exclusions.filter((e) => !present.has(`${e.pageId}::${e.nodeId}`));
}

/** Exact mode ships every authored block, so an exclusion list with entries is refused before any stage could apply it. */
export function assertExclusionsPermitted(fidelityMode: 'exact' | 'permissive', exclusions: BlockExclusion[]): void {
  if (fidelityMode !== 'exact' || !exclusions.length) return;
  throw new Error(`block exclusions are not permitted in exact mode: plan/block-exclusions.yaml names ${exclusions.map((e) => `${e.pageId}:${e.nodeId}`).join(', ')}; every authored block, images included, must ship`);
}

/** Remove excluded nodes and their subtrees; with a ledger, record each removed node as excluded. */
export function applyBlockExclusions(doc: DocIR, exclusions: BlockExclusion[], ledger?: Ledger): DocIR {
  const mine = new Map(exclusions.filter((e) => e.pageId === doc.pageId).map((e) => [e.nodeId, e]));
  if (!mine.size) return doc;
  const prune = (blocks: Block[]): Block[] => blocks.flatMap((b): Block[] => {
    const hit = mine.get(b.id);
    if (hit) {
      if (ledger) walkBlocks([b], (n) => { ledger.excluded(doc.pageId, n.id, hit.reason, hit.reviewer); });
      return [];
    }
    if (b.type === 'list') return [{ ...b, children: b.children.map((li) => ({ ...li, children: prune(li.children) })) }];
    if (isBlockWithChildren(b)) return [{ ...b, children: prune(b.children as Block[]) } as Block];
    return [b];
  });
  return { ...doc, children: prune(doc.children) };
}
