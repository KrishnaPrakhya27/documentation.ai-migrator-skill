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
import { walkBlocks, inlineText } from '../ir/types.js';
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

type Handler = (node: ComponentNode, rule: MappingRule, ctx: EngineOptions) => Block[];

/** Resolve "$prop", "$map(prop)", "$count", literal. */
function resolveProp(v: string | number | boolean, node: ComponentNode, target: string, contract = loadContract()): string | number | boolean | null {
  if (typeof v !== 'string' || !v.startsWith('$')) return v;
  const m = v.match(/^\$(\w+)(?:\((\w+)\))?$/);
  if (!m) return v;
  const [, fn, arg] = m;
  if (fn === 'count') return node.children.length;
  if (fn === 'map' && arg) {
    const raw = node.props[arg];
    const map = contract.valueMaps[target]?.[arg] ?? {};
    if (raw === null || raw === undefined) return null;
    const s = String(raw).toLowerCase();
    return map[s] ?? s;
  }
  // "$name" copies a source prop
  const val = node.props[fn];
  return val === undefined ? null : val;
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
const HANDLERS: Record<string, Handler> = {
  /** Wrapper whose children are cards: <Cards columns={3}> → <Columns cols={3}> with Card children. */
  'cards-to-columns': (node, rule) => {
    const cols = Number(node.props.columns ?? node.props.cols ?? 2) || 2;
    return [{ id: node.id, type: 'dai', name: 'Columns', props: { cols: [2, 3, 4].includes(cols) ? cols : 2 }, children: node.children, rule: rule.id }];
  },
  /** ReadMe/Docusaurus <Column> children unwrap; parent Columns gets cols=$count. */
  'columns-count-children': (node, rule) => {
    const kids = node.children.flatMap((c) => (c.type === 'component' && c.name === 'Column' ? c.children : [c]));
    const count = node.children.filter((c) => c.type === 'component' && c.name === 'Column').length || 2;
    return [{ id: node.id, type: 'dai', name: 'Columns', props: { cols: Math.min(4, Math.max(2, count)) }, children: kids, rule: rule.id }];
  },
  /** A tab-set whose tabs carry `title`; ensures each child is a Tab. */
  'tabs': (node, rule) => {
    const tabs: Block[] = node.children.map((c) => {
      if (c.type === 'component') return { id: c.id, type: 'dai', name: 'Tab', props: { title: String(c.props.title ?? c.props.label ?? 'Tab') }, children: c.children, rule: rule.id } as DaiComponentNode;
      return c;
    });
    return [{ id: node.id, type: 'dai', name: 'Tabs', props: {}, children: tabs, rule: rule.id }];
  },
  /** Numbered list → Steps/Step (title = first line of the item). */
  'list-to-steps': (node, rule) => {
    const list = node.children.find((c) => c.type === 'list' && c.ordered);
    if (!list || list.type !== 'list') return [{ id: node.id, type: 'dai', name: 'Steps', props: {}, children: node.children, rule: rule.id }];
    const steps: Block[] = list.children.map((li) => {
      const [first, ...rest] = li.children;
      const title = first && first.type === 'paragraph' ? inlineText(first.children).slice(0, 120) : 'Step';
      return { id: li.id, type: 'dai', name: 'Step', props: { title }, children: rest.length ? rest : [], rule: rule.id } as DaiComponentNode;
    });
    return [{ id: node.id, type: 'dai', name: 'Steps', props: {}, children: steps, rule: rule.id }];
  },
  /** FAQ container → ExpandableGroup of Expandable(question). */
  'faq-to-expandable-group': (node, rule) => {
    const items: Block[] = node.children.map((c) => {
      if (c.type === 'component') return { id: c.id, type: 'dai', name: 'Expandable', props: { title: String(c.props.summary ?? c.props.title ?? c.props.question ?? 'Details') }, children: c.children, rule: rule.id } as DaiComponentNode;
      return c;
    });
    return [{ id: node.id, type: 'dai', name: 'ExpandableGroup', props: {}, children: items, rule: rule.id }];
  },
  /** Embed with a URL → Iframe when host allowlisted, else quarantine. */
  'embed-to-iframe': (node, rule, ctx) => {
    const src = String(node.props.src ?? node.props.url ?? '');
    let host = '';
    try { host = new URL(src).hostname; } catch { /* not a URL */ }
    const yt = src.match(/youtube\.com\/watch\?v=([\w-]+)/) ?? src.match(/youtu\.be\/([\w-]+)/);
    const finalSrc = yt ? `https://www.youtube.com/embed/${yt[1]}` : src;
    const allowed = (ctx.iframeHosts ?? ['www.youtube.com', 'youtube.com', 'youtu.be', 'player.vimeo.com', 'www.loom.com']).some((h) => host === h || host.endsWith('.' + h));
    if (!allowed) return [{ id: node.id, type: 'quarantined', reason: `embed host "${host || 'unknown'}" not allowlisted`, original: node }];
    return [{ id: node.id, type: 'dai', name: 'Iframe', props: { src: finalSrc, title: String(node.props.title ?? 'Embedded content') }, children: [], rule: rule.id }];
  },
  /** Tooltip/abbr compose (T4): text with <abbr title> */
  'tooltip-to-abbr': (node, rule) => {
    const tip = String(node.props.tip ?? node.props.title ?? node.props.content ?? '');
    const text = blocksToMdx(node.children).trim() || String(node.props.text ?? '');
    return [{ id: node.id, type: 'rawHtml', value: `<abbr title="${tip.replace(/"/g, '&quot;')}">${text.replace(/</g, '&lt;')}</abbr>`, reviewFlag: 'T4 compose: tooltip → abbr' }];
  },
  /** Badge compose (T4): inline span with a namespaced class; CSS rule emitted separately by the css policy. */
  'badge-to-span': (node, rule) => {
    const text = blocksToMdx(node.children).trim() || String(node.props.text ?? node.props.label ?? '');
    return [{ id: node.id, type: 'rawHtml', value: `<span className="dai-mig-badge">${text.replace(/</g, '&lt;')}</span>`, reviewFlag: 'T4 compose: badge → span (custom CSS)' }];
  },
  /** Frame/figure with caption → Image + italic caption. */
  'frame-to-image': (node, rule) => {
    const out: Block[] = [...node.children];
    const cap = node.props.caption;
    if (cap) out.push({ id: node.id + ':cap', type: 'paragraph', children: [{ id: node.id + ':cap:t', type: 'emphasis', children: [{ id: node.id + ':cap:tt', type: 'text', value: String(cap) }] }] });
    return out;
  },
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
        const withKids: ComponentNode = { ...b, children: this.resolveBlocks(b.children, pageId) };
        out.push(...this.resolveComponent(withKids, pageId));
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

  private resolveComponent(node: ComponentNode, pageId: string): Block[] {
    const sig = signatureOf(node);
    const plan = this.opts.plan?.[sig.hash];

    if (plan?.status === 'excluded') {
      this.opts.ledger.excluded(pageId, node.id, plan.reason ?? 'excluded by plan', plan.reviewer);
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
    if (rule.handler) {
      const h = HANDLERS[rule.handler];
      if (!h) throw new Error(`Unknown handler ${rule.handler} in rule ${rule.id}`);
      result = h(node, rule, this.opts);
    } else if (rule.children === 'unwrap') {
      result = node.children;
    } else if (rule.children === 'drop') {
      this.markSubtree(node, pageId, 'excluded', `dropped by rule ${rule.id}`, `rule:${rule.id}`);
      this.opts.log.record({ stage: 'convert', pageId, sourceNodeId: node.id, signature: signatureOf(node).hash, tier: rule.tier, rule: rule.id, lossy: ['subtree dropped'] });
      return [];
    } else if (rule.to) {
      const props: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(rule.to.props ?? {})) {
        const rv = resolveProp(v, node, rule.to.name);
        if (rv !== null) props[k] = rv;
      }
      result = [{ id: node.id, type: 'dai', name: rule.to.name, props, children: node.children, rule: rule.id }];
    } else {
      throw new Error(`Rule ${rule.id} has neither to, handler nor children:unwrap`);
    }
    const lossy = [
      ...(rule.drop ?? []).filter((p) => node.props[p] !== undefined && node.props[p] !== null).map((p) => `${p} dropped`),
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
  private markSubtree(node: ComponentNode, pageId: string, kind: 'excluded' | 'quarantined', reason: string, reviewer?: string): void {
    const mark = (id: string) => (kind === 'excluded' ? this.opts.ledger.excluded(pageId, id, reason, reviewer) : this.opts.ledger.quarantined(pageId, id, reason));
    mark(node.id);
    walkBlocks(node.children, (n) => { mark(n.id); });
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
