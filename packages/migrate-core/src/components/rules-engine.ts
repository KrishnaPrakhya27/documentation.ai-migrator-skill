/**
 * The Component Conversion Engine. Resolves every source ComponentNode to a
 * Documentation.AI component (T0–T4), a static port (T5), a learned rule (T6)
 * or a sanitised/quarantined block (T7), and records a ledger disposition
 * for every node it touches.
 *
 * Rules are declarative YAML per platform; restructures that need code are
 * named handlers referenced from rules.
 */
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import type { Block, ComponentNode, DaiComponentNode, DocIR, Inline, QuarantinedNode, RawHtmlNode } from '../ir/types.js';
import { walkBlocks, inlineText, isBlockWithChildren } from '../ir/types.js';
import { Ledger } from '../ledger/dispositions.js';
import { sanitizeHtmlToJsx } from './sanitize.js';
import { blocksToMdx } from '../ir/to-dai-mdx.js';
import { loadContract } from '@dai/content-contract';
import type { Tier } from '../log/decisions.js';
import { DecisionLog } from '../log/decisions.js';
import { signatureOf } from './signature.js';

export interface MappingRule {
  id: string;
  tier: Tier;
  match: { name: string; props?: Record<string, string | number | boolean | 'any'>; class?: string };
  /** Target component; omit when `handler` produces the output. */
  to?: { name: string; props?: Record<string, string | number | boolean> };
  /** Source props to drop (recorded as lossy). */
  drop?: string[];
  /** 'keep' (default), 'unwrap' (children replace the component) or 'drop' (nothing is emitted; the subtree is recorded as excluded by rule). */
  children?: 'keep' | 'unwrap' | 'drop';
  /** Named restructure handler implemented in code. */
  handler?: string;
  note?: string;
}

export interface MappingTable { platform: string; version: number; rules: MappingRule[] }

export function loadMappings(paths: string[]): MappingTable[] {
  return paths.map((p) => parseYaml(readFileSync(p, 'utf8')) as MappingTable);
}

/** Per-cluster decision from plan/component-plan.yaml. */
export interface ComponentPlanEntry {
  cluster: string;
  tier: Tier;
  rule?: string;
  mode?: 'static';
  status?: 'auto' | 'needs-review' | 'approved' | 'quarantined' | 'excluded';
  reviewer?: string;
  reason?: string;
}

export interface EngineOptions {
  platform: string;
  mappings: MappingTable[];
  plan?: Record<string, ComponentPlanEntry>;
  ledger: Ledger;
  log: DecisionLog;
  iframeHosts?: string[];
}

interface HandlerResult { blocks: Block[]; lossy?: string[] }
type Handler = (node: ComponentNode, rule: MappingRule, ctx: EngineOptions) => HandlerResult;
/** A restructure handler with the source props it reads, so every other authored prop is reported as dropped. */
interface RestructureHandler { reads: string[]; run: Handler }

type PropReference = { kind: 'count' } | { kind: 'copy'; prop: string } | { kind: 'map'; prop: string };

/** "$count", "$prop" (copy) or "$map(prop)" (copy through the contract value map); anything else is a literal. */
function propReference(v: string | number | boolean): PropReference | undefined {
  if (typeof v !== 'string' || !v.startsWith('$')) return undefined;
  // prop names may be hyphenated, as the contract's own API fields are (param-type, field-type)
  const m = v.match(/^\$([\w-]+)(?:\(([\w-]+)\))?$/);
  if (!m) return undefined;
  const [, fn, arg] = m;
  if (fn === 'count') return { kind: 'count' };
  if (fn === 'map' && arg) return { kind: 'map', prop: arg };
  return { kind: 'copy', prop: fn };
}

function resolveProp(v: string | number | boolean, node: ComponentNode, target: string, targetProp: string, contract = loadContract()): string | number | boolean | null {
  const reference = propReference(v);
  if (!reference) return v;
  if (reference.kind === 'count') return node.children.length;
  const raw = node.props[reference.prop];
  if (raw === null || raw === undefined) return null;
  if (reference.kind === 'copy') return raw;
  // the value map is keyed by the target component and target prop (e.g. Callout.kind), whatever the source prop was called
  const map = contract.valueMaps[target]?.[targetProp] ?? contract.valueMaps[target]?.[reference.prop] ?? {};
  const s = String(raw).toLowerCase();
  return map[s] ?? s;
}

/** The column counts the contract renders and the count it uses when the author set none (the same default as Mintlify). */
function columnsPolicy(contract = loadContract()): { allowed: number[]; fallback: number } {
  const cols = contract.components.find((component) => component.name === 'Columns')?.props.cols;
  const allowed = (cols?.enum ?? []).filter((value): value is number => typeof value === 'number');
  if (!allowed.length || typeof cols?.default !== 'number') throw new Error('content contract does not declare Columns.cols enum and default');
  return { allowed, fallback: cols.default };
}

function quarantined(node: ComponentNode, reason: string): HandlerResult {
  return { blocks: [{ id: node.id, type: 'quarantined', reason, original: node }] };
}

function matches(rule: MappingRule, node: ComponentNode): boolean {
  if (rule.match.name !== node.name) return false;
  if (rule.match.class && !(node.styleDeps ?? []).includes(rule.match.class)) return false;
  for (const [k, v] of Object.entries(rule.match.props ?? {})) {
    if (v === 'any') { if (node.props[k] === undefined || node.props[k] === null) return false; continue; }
    if (String(node.props[k]) !== String(v)) return false;
  }
  return true;
}

/** Restructure handlers (T3). */
const HANDLERS: Record<string, RestructureHandler> = {
  /** Wrapper whose children are cards: <CardGroup cols={3}> → <Columns cols={3}> with Card children. */
  'cards-to-columns': { reads: ['cols', 'columns'], run: (node, rule) => {
    const { allowed, fallback } = columnsPolicy();
    const authored = node.props.cols ?? node.props.columns;
    if (authored !== undefined && authored !== null && !Number.isInteger(Number(authored))) return quarantined(node, `cols "${String(authored)}" is not a whole number`);
    // an absent prop renders the platform default, so the source's own layout is kept rather than one derived from the card count
    const requested = authored === undefined || authored === null ? fallback : Number(authored);
    const [lowest, highest] = [Math.min(...allowed), Math.max(...allowed)];
    const cols = Math.min(highest, Math.max(lowest, requested));
    const lossy = cols === requested ? [] : [`cols ${requested} clamped to ${cols} (contract allows ${allowed.join(', ')})`];
    return { blocks: [{ id: node.id, type: 'dai', name: 'Columns', props: { cols }, children: node.children, rule: rule.id }], lossy };
  } },
  /** ReadMe/Docusaurus <Column> children unwrap; parent Columns gets cols=$count. */
  'columns-count-children': { reads: [], run: (node, rule) => {
    const kids = node.children.flatMap((c) => (c.type === 'component' && c.name === 'Column' ? c.children : [c]));
    const count = node.children.filter((c) => c.type === 'component' && c.name === 'Column').length || 2;
    return { blocks: [{ id: node.id, type: 'dai', name: 'Columns', props: { cols: Math.min(4, Math.max(2, count)) }, children: kids, rule: rule.id }] };
  } },
  /** A tab-set whose tabs carry `title`; ensures each child is a Tab. */
  'tabs': { reads: [], run: (node, rule) => {
    const tabs: Block[] = node.children.map((c) => {
      if (c.type === 'component') return { id: c.id, type: 'dai', name: 'Tab', props: { title: String(c.props.title ?? c.props.label ?? 'Tab') }, children: c.children, rule: rule.id } as DaiComponentNode;
      return c;
    });
    return { blocks: [{ id: node.id, type: 'dai', name: 'Tabs', props: {}, children: tabs, rule: rule.id }] };
  } },
  /** Numbered list → Steps/Step (title = first line of the item). */
  'list-to-steps': { reads: [], run: (node, rule) => {
    const list = node.children.find((c) => c.type === 'list' && c.ordered);
    if (!list || list.type !== 'list') return { blocks: [{ id: node.id, type: 'dai', name: 'Steps', props: {}, children: node.children, rule: rule.id }] };
    const steps: Block[] = list.children.map((li) => {
      const [first, ...rest] = li.children;
      const title = first && first.type === 'paragraph' ? inlineText(first.children).slice(0, 120) : 'Step';
      return { id: li.id, type: 'dai', name: 'Step', props: { title }, children: rest.length ? rest : [], rule: rule.id } as DaiComponentNode;
    });
    return { blocks: [{ id: node.id, type: 'dai', name: 'Steps', props: {}, children: steps, rule: rule.id }] };
  } },
  /** FAQ container → ExpandableGroup of Expandable(question). */
  'faq-to-expandable-group': { reads: [], run: (node, rule) => {
    const items: Block[] = node.children.map((c) => {
      if (c.type === 'component') return { id: c.id, type: 'dai', name: 'Expandable', props: { title: String(c.props.summary ?? c.props.title ?? c.props.question ?? 'Details') }, children: c.children, rule: rule.id } as DaiComponentNode;
      return c;
    });
    return { blocks: [{ id: node.id, type: 'dai', name: 'ExpandableGroup', props: {}, children: items, rule: rule.id }] };
  } },
  /** Embed with a URL → Iframe when host allowlisted, else quarantine. */
  'embed-to-iframe': { reads: ['src', 'url', 'title'], run: (node, rule, ctx) => {
    const src = String(node.props.src ?? node.props.url ?? '');
    let host = '';
    try { host = new URL(src).hostname; } catch { /* not a URL */ }
    const yt = src.match(/youtube\.com\/watch\?v=([\w-]+)/) ?? src.match(/youtu\.be\/([\w-]+)/);
    const finalSrc = yt ? `https://www.youtube.com/embed/${yt[1]}` : src;
    const allowed = (ctx.iframeHosts ?? ['www.youtube.com', 'youtube.com', 'youtu.be', 'player.vimeo.com', 'www.loom.com']).some((h) => host === h || host.endsWith('.' + h));
    if (!allowed) return quarantined(node, `embed host "${host || 'unknown'}" not allowlisted`);
    return { blocks: [{ id: node.id, type: 'dai', name: 'Iframe', props: { src: finalSrc, title: String(node.props.title ?? 'Embedded content') }, children: [], rule: rule.id }] };
  } },
  /** Tooltip/abbr compose (T4): text with <abbr title> */
  'tooltip-to-abbr': { reads: ['tip', 'title', 'content', 'text'], run: (node) => {
    const tip = String(node.props.tip ?? node.props.title ?? node.props.content ?? '');
    const text = blocksToMdx(node.children).trim() || String(node.props.text ?? '');
    return { blocks: [{ id: node.id, type: 'rawHtml', value: `<abbr title="${tip.replace(/"/g, '&quot;')}">${text.replace(/</g, '&lt;')}</abbr>`, reviewFlag: 'T4 compose: tooltip → abbr' }] };
  } },
  /** Badge compose (T4): inline span with a namespaced class; CSS rule emitted separately by the css policy. */
  'badge-to-span': { reads: ['text', 'label'], run: (node) => {
    const text = blocksToMdx(node.children).trim() || String(node.props.text ?? node.props.label ?? '');
    return { blocks: [{ id: node.id, type: 'rawHtml', value: `<span className="dai-mig-badge">${text.replace(/</g, '&lt;')}</span>`, reviewFlag: 'T4 compose: badge → span (custom CSS)' }] };
  } },
  /** Frame around one image: a figure when it carries a caption, otherwise the bare image (the frame itself is presentation). */
  'frame-to-image': { reads: ['caption'], run: (node) => {
    const caption = typeof node.props.caption === 'string' && node.props.caption.trim() ? node.props.caption : undefined;
    const [onlyChild] = node.children;
    if (node.children.length === 1 && onlyChild.type === 'image') {
      return { blocks: caption ? [{ id: node.id, type: 'figure', image: onlyChild, caption: [{ id: node.id + ':cap:t', type: 'text', value: caption }] }] : [onlyChild] };
    }
    const blocks: Block[] = [...node.children];
    if (caption) blocks.push({ id: node.id + ':cap', type: 'paragraph', children: [{ id: node.id + ':cap:t', type: 'emphasis', children: [{ id: node.id + ':cap:tt', type: 'text', value: caption }] }] });
    return { blocks };
  } },
  /** GitBook step: it has no title of its own, so its leading heading becomes the title the Step contract requires. */
  'step-title-from-heading': { reads: [], run: (node, rule) => {
    const [first, ...rest] = node.children;
    const title = first?.type === 'heading' ? inlineText(first.children).trim() : '';
    if (!title || first?.type !== 'heading') return { blocks: [{ id: node.id, type: 'dai', name: 'Step', props: { title: 'Step' }, children: node.children, rule: rule.id }], lossy: ['no leading heading; Step title defaulted to "Step"'] };
    // the title renders as a heading element, at the source level where the contract has one (h2, h3)
    const titleType = first.depth <= 2 ? 'h2' : 'h3';
    const lossy = [`leading heading "${title}" became the Step title`, ...(first.depth > 3 ? [`heading level ${first.depth} rendered as h3`] : [])];
    return { blocks: [{ id: node.id, type: 'dai', name: 'Step', props: { title, titleType }, children: rest, rule: rule.id }], lossy };
  } },
  /** Embed: an Iframe when the host may be framed, otherwise the link a reader of the source followed. */
  'embed-to-iframe-or-link': { reads: ['src', 'url', 'title'], run: (node, rule, ctx) => {
    const framed = HANDLERS['embed-to-iframe'].run(node, rule, ctx);
    const src = String(node.props.src ?? node.props.url ?? '');
    if (framed.blocks[0]?.type !== 'quarantined' || !/^https?:\/\//i.test(src)) return framed;
    const link: Inline = { id: `${node.id}:link`, type: 'link', url: src, title: typeof node.props.title === 'string' ? node.props.title : undefined, children: [{ id: `${node.id}:text`, type: 'text', value: src }] };
    return { blocks: [{ id: node.id, type: 'paragraph', children: [link] }], lossy: [`embed of ${new URL(src).hostname} kept as a link: the host is not allowlisted for iframes`] };
  } },
};

export class RulesEngine {
  private rules: MappingRule[];
  constructor(private opts: EngineOptions) {
    this.rules = opts.mappings.filter((m) => m.platform === opts.platform || m.platform === '*').flatMap((m) => m.rules);
  }

  findRule(node: ComponentNode): MappingRule | undefined {
    return this.rules.find((r) => matches(r, node));
  }

  /** Resolve every ComponentNode in the document, depth-first, children first. */
  resolveDoc(doc: DocIR): DocIR {
    const resolved = this.resolveBlocks(doc.children, doc.pageId);
    return { ...doc, children: resolved };
  }

  resolveBlocks(blocks: Block[], pageId: string): Block[] {
    const out: Block[] = [];
    for (const b of blocks) {
      if (b.type === 'component') {
        // children first so nested source components are resolved before the parent rule sees them
        // the plan was keyed on the raw signature at inventory time, so compute it before children are resolved
        const sig = signatureOf(b);
        const withKids: ComponentNode = { ...b, children: this.resolveBlocks(b.children, pageId) };
        out.push(...this.resolveComponent(withKids, pageId, sig, b));
      } else if (b.type === 'list') {
        this.opts.ledger.identical(pageId, b.id);
        out.push({ ...b, children: b.children.map((li) => { this.opts.ledger.identical(pageId, li.id); return { ...li, children: this.resolveBlocks(li.children, pageId) }; }) });
      } else if (b.type === 'blockquote') {
        this.opts.ledger.identical(pageId, b.id);
        out.push({ ...b, children: this.resolveBlocks(b.children, pageId) });
      } else if (b.type === 'dai') {
        out.push({ ...b, children: this.resolveBlocks(b.children, pageId) });
      } else if (b.type === 'html') {
        const value = sanitizeHtmlToJsx(b.value, { iframeHosts: this.opts.iframeHosts });
        if (!value) {
          this.opts.ledger.quarantined(pageId, b.id, 'raw HTML removed completely by sanitisation');
          this.opts.log.record({ stage: 'convert', pageId, sourceNodeId: b.id, tier: 'T7', rule: 'T7/raw-html-quarantine', note: 'raw HTML removed completely by sanitisation' });
          out.push({ id: b.id, type: 'quarantined', reason: 'raw HTML removed completely by sanitisation', original: b });
        } else {
          this.opts.ledger.transformed(pageId, b.id, [b.id], 'T7/raw-html-sanitise', ['unsafe tags, attributes and inline styles removed']);
          this.opts.log.record({ stage: 'convert', pageId, sourceNodeId: b.id, tier: 'T7', rule: 'T7/raw-html-sanitise' });
          out.push({ id: b.id, type: 'rawHtml', value, reviewFlag: 'T7 preserve: sanitised raw HTML' });
        }
      } else if ((b.type === 'image' && !b.alt) || (b.type === 'figure' && !b.image.alt)) {
        this.opts.ledger.transformed(pageId, b.id, [b.id], 'T2/alt-missing', ['alt text missing in source; emitted alt=""']);
        this.opts.log.record({ stage: 'convert', pageId, sourceNodeId: b.id, tier: 'T2', rule: 'T2/alt-missing', lossy: ['alt missing'] });
        out.push(b);
      } else {
        this.opts.ledger.identical(pageId, b.id);
        out.push(b);
      }
    }
    return out;
  }

  private resolveComponent(node: ComponentNode, pageId: string, sig = signatureOf(node), original: ComponentNode = node): Block[] {
    this.original = original;
    const plan = this.opts.plan?.[sig.hash];

    if (plan?.status === 'excluded') {
      // The whole subtree goes, so the whole subtree is recorded: a child left with its own earlier
      // disposition would claim in the ledger that it survived unchanged, when nothing of it was emitted.
      this.markSubtree(node, pageId, 'excluded', plan.reason ?? 'excluded by plan', plan.reviewer);
      return [];
    }
    if (plan?.status === 'quarantined') {
      return this.quarantine(node, pageId, plan.reason ?? 'plan: quarantined');
    }
    if (node.styleDeps?.some((x) => x.startsWith('expression:')) && plan?.status !== 'approved') {
      return this.quarantine(node, pageId, 'source MDX contains a non-literal expression; explicit reviewed approval is required');
    }

    const rule = plan?.rule ? this.rules.find((r) => r.id === plan.rule) : this.findRule(node);
    if (rule) return this.apply(node, rule, pageId);

    // No rule: T7 preserve as sanitised fragment (flagged) or quarantine when sanitisation yields nothing.
    return this.preserve(node, pageId, 'no mapping rule for signature ' + sig.hash);
  }

  private apply(node: ComponentNode, rule: MappingRule, pageId: string): Block[] {
    let result: Block[];
    /** Source props the rule carries into the output; every other authored prop is a recorded loss. */
    let mapped: string[];
    let handlerLossy: string[] = [];
    if (rule.handler) {
      const handler = HANDLERS[rule.handler];
      if (!handler) throw new Error(`Unknown handler ${rule.handler} in rule ${rule.id}`);
      const outcome = handler.run(node, rule, this.opts);
      result = outcome.blocks;
      handlerLossy = outcome.lossy ?? [];
      mapped = handler.reads;
    } else if (rule.children === 'unwrap') {
      result = node.children;
      mapped = [];
    } else if (rule.children === 'drop') {
      this.markSubtree(node, pageId, 'excluded', `dropped by rule ${rule.id}`, `rule:${rule.id}`);
      this.opts.log.record({ stage: 'convert', pageId, sourceNodeId: node.id, signature: signatureOf(node).hash, tier: rule.tier, rule: rule.id, lossy: ['subtree dropped'] });
      return [];
    } else if (rule.to) {
      const props: Record<string, string | number | boolean | null> = {};
      mapped = [];
      for (const [k, v] of Object.entries(rule.to.props ?? {})) {
        const reference = propReference(v);
        if (reference && reference.kind !== 'count') mapped.push(reference.prop);
        const rv = resolveProp(v, node, rule.to.name, k);
        if (rv !== null) props[k] = rv;
      }
      result = [{ id: node.id, type: 'dai', name: rule.to.name, props, children: node.children, rule: rule.id }];
    } else {
      throw new Error(`Rule ${rule.id} has neither to, handler nor children:unwrap`);
    }
    const authored = Object.keys(node.props).filter((p) => node.props[p] !== undefined && node.props[p] !== null);
    const dropped = rule.drop ?? [];
    const lossy = [
      ...authored.filter((p) => dropped.includes(p)).map((p) => `${p} dropped`),
      ...authored.filter((p) => !dropped.includes(p) && !mapped.includes(p)).map((p) => `${p} dropped (no mapping in ${rule.id})`),
      ...handlerLossy,
      ...(node.styleDeps ?? []).filter((x) => x.startsWith('expression:')).map((x) => `${x} removed without evaluation`),
    ];
    const outIds = result.map((r) => r.id);
    const quarantined = result.find((r): r is QuarantinedNode => r.type === 'quarantined');
    if (quarantined) {
      this.opts.ledger.quarantined(pageId, node.id, quarantined.reason);
      this.opts.log.record({ stage: 'convert', pageId, sourceNodeId: node.id, signature: signatureOf(node).hash, tier: 'T7', rule: rule.id, note: quarantined.reason });
    } else {
      this.opts.ledger.transformed(pageId, node.id, outIds, rule.id, lossy);
      this.opts.log.record({ stage: 'convert', pageId, sourceNodeId: node.id, signature: signatureOf(node).hash, tier: rule.tier, rule: rule.id, lossy, original: `<${node.name}>`, output: result.map((r) => (r.type === 'dai' ? `<${r.name}>` : r.type)).join(',') });
    }
    return result;
  }

  private preserve(node: ComponentNode, pageId: string, why: string): Block[] {
    const inner = blocksToMdx(node.children);
    const html = sanitizeHtmlToJsx(`<div data-source-component="${node.name}">${inner}</div>`);
    if (!html.trim() || !inner.trim()) return this.quarantine(node, pageId, `${why}; nothing representable after sanitisation`);
    const raw: RawHtmlNode = { id: node.id, type: 'rawHtml', value: html, reviewFlag: `T7 preserve: ${why}` };
    this.opts.ledger.transformed(pageId, node.id, [raw.id], 'T7/preserve', ['component semantics lost; content kept as sanitised fragment']);
    this.opts.log.record({ stage: 'convert', pageId, sourceNodeId: node.id, signature: signatureOf(node).hash, tier: 'T7', rule: 'T7/preserve', note: why });
    return [raw];
  }

  /** Record a disposition for a component and every node beneath it (last write wins in the ledger). */
  /** The unresolved source node for the component currently being resolved; subtree marks must cover source ids, not resolved replacements. */
  private original?: ComponentNode;

  private markSubtree(node: ComponentNode, pageId: string, kind: 'excluded' | 'quarantined', reason: string, reviewer?: string): void {
    const mark = (id: string) => (kind === 'excluded' ? this.opts.ledger.excluded(pageId, id, reason, reviewer) : this.opts.ledger.quarantined(pageId, id, reason));
    const src = this.original && this.original.id === node.id ? this.original : node;
    mark(src.id);
    walkBlocks(src.children, (n) => { mark(n.id); });
  }

  private quarantine(node: ComponentNode, pageId: string, reason: string): Block[] {
    this.markSubtree(node, pageId, 'quarantined', reason);
    this.opts.log.record({ stage: 'convert', pageId, sourceNodeId: node.id, signature: signatureOf(node).hash, tier: 'T7', rule: 'T7/quarantine', note: reason });
    return [{ id: node.id, type: 'quarantined', reason, original: node }];
  }
}

/** Every ComponentNode in a document (for inventories). */
export function collectComponents(doc: DocIR): ComponentNode[] {
  const out: ComponentNode[] = [];
  walkBlocks(doc.children, (n) => { if (n.type === 'component') out.push(n); });
  return out;
}

/**
 * The source as the operator approved it at gate 2, for exact-fidelity comparison.
 *
 * `source-content-exact` rebuilds the source from the frozen bytes and compares it with the written
 * output. The mapping rules the operator approved declare, per component, exactly which authored
 * material does not survive: `drop` names props, `children: 'drop'` names a whole subtree (platform
 * chrome such as a GitBook Assistant prompt), and `children: 'unwrap'` discards a wrapper's props
 * while keeping its content in reading order. Comparing against a source that still carries them
 * reports every such page as different, which is what happened on this GitBook migration: 16 of 41
 * pages quarantined for losses that were reviewed and accepted at gate 2.
 *
 * Only those declared losses are applied. Handlers are deliberately NOT run here: a handler is the
 * conversion under test, and re-running it on the source side would compare the conversion with
 * itself. So a handler that lost a paragraph, a rename that lost a prop, or any loss no approved
 * rule declared, all still fail the gate.
 */
export function applyDeclaredLosses(doc: DocIR, engine: RulesEngine): DocIR {
  const strip = (blocks: Block[]): Block[] => blocks.flatMap((block): Block[] => {
    if (block.type === 'list') return [{ ...block, children: block.children.map((li) => ({ ...li, children: strip(li.children) })) }];
    if (block.type !== 'component') return isBlockWithChildren(block) ? [{ ...block, children: strip(block.children as Block[]) } as Block] : [block];
    const rule = engine.findRule(block);
    // A handler decides this node's shape; leave it exactly as the source stated it.
    if (rule?.handler) return [{ ...block, children: strip(block.children) }];
    if (rule?.children === 'drop') return [];
    if (rule?.children === 'unwrap') return strip(block.children);
    if (!rule?.drop?.length) return [{ ...block, children: strip(block.children) }];
    const props = { ...block.props };
    for (const prop of rule.drop) delete props[prop];
    return [{ ...block, props, children: strip(block.children) }];
  });
  return { ...doc, children: strip(doc.children) };
}
