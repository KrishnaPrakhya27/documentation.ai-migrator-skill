/**
 * Scored platform detection. Weighted signals produce a platform and a
 * confidence; close scores or a low top score raise an ambiguity gate.
 */
import { parseHtml, find, findAll, type El } from '../ir/from-html.js';
import { PROFILES, type ScrapeProfile } from './profiles.js';

export interface FingerprintResult {
  platform: string;
  confidence: number;
  matched: string[];
}

export interface Fingerprint {
  best: FingerprintResult | null;
  ranked: FingerprintResult[];
  ambiguous: boolean;
  reason?: string;
}

const AMBIGUITY_GAP = 0.15;
const MIN_CONFIDENCE = 0.6;

function metaMap(root: El): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of findAll(root, 'meta')) {
    const k = m.attribs.name ?? m.attribs.property;
    if (k) out[k.toLowerCase()] = m.attribs.content ?? '';
  }
  return out;
}

function scoreProfile(p: ScrapeProfile, ctx: { root?: El; html?: string; paths?: string[]; mdSuffixWorks?: boolean }): FingerprintResult {
  let total = 0; let got = 0; const matched: string[] = [];
  const metas = ctx.root ? metaMap(ctx.root) : {};
  for (const s of p.signals) {
    const applicable = (s.kind === 'path' || s.kind === 'archive') ? !!ctx.paths : (s.kind === 'md-suffix' ? ctx.mdSuffixWorks !== undefined : !!ctx.root);
    if (!applicable) continue;
    total += s.weight;
    let hit = false;
    switch (s.kind) {
      case 'meta': {
        const [k, v] = s.pattern.split('=');
        const val = metas[k.toLowerCase()];
        hit = val !== undefined && new RegExp(`^${v}$`, 'i').test(val);
        break;
      }
      case 'dom': hit = !!ctx.root && !!find(ctx.root, s.pattern); break;
      case 'asset': hit = !!ctx.html && ctx.html.includes(s.pattern); break;
      case 'path': case 'archive': hit = !!ctx.paths && ctx.paths.some((f) => f.endsWith(s.pattern) || f.includes(`/${s.pattern}`) || f === s.pattern); break;
      case 'md-suffix': hit = ctx.mdSuffixWorks === true; break;
    }
    if (hit) { got += s.weight; matched.push(`${s.kind}:${s.pattern}`); }
  }
  return { platform: p.platform, confidence: total ? got / total : 0, matched };
}

export function fingerprint(ctx: { html?: string; paths?: string[]; mdSuffixWorks?: boolean }): Fingerprint {
  const root = ctx.html ? parseHtml(ctx.html) : undefined;
  const ranked = Object.values(PROFILES)
    .filter((p) => p.platform !== 'generic')
    .map((p) => scoreProfile(p, { root, html: ctx.html, paths: ctx.paths, mdSuffixWorks: ctx.mdSuffixWorks }))
    .filter((r) => r.matched.length > 0)
    .sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0] ?? null;
  if (!best) return { best: null, ranked, ambiguous: true, reason: 'no platform signals matched; use migrate-generic or pass --platform' };
  const second = ranked[1];
  if (best.confidence < MIN_CONFIDENCE) return { best, ranked, ambiguous: true, reason: `top score ${best.confidence.toFixed(2)} below ${MIN_CONFIDENCE}` };
  if (second && best.confidence - second.confidence < AMBIGUITY_GAP) return { best, ranked, ambiguous: true, reason: `${best.platform} and ${second.platform} score within ${AMBIGUITY_GAP}; hybrid or customised site` };
  return { best, ranked, ambiguous: false };
}
