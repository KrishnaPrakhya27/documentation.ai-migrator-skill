/**
 * Slug rules matching the platform: kebab-case segments, lowercase, and the
 * heading slugger the renderer uses (github-slugger with dashes collapsed).
 */
import GithubSlugger from 'github-slugger';
import { SLUG_RULES } from '@dai/content-contract';

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'page';
}

/** Path → legal DAI path, preserving case only when allowed. Returns the change reason when altered. */
export function legalisePath(path: string, opts: { case: 'preserve' | 'lower' }): { path: string; changed: boolean; reason?: string } {
  const segs = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const out: string[] = [];
  let changed = false; const reasons: string[] = [];
  for (const s of segs) {
    let seg = decodeURIComponent(s);
    if (opts.case === 'lower') { const l = seg.toLowerCase(); if (l !== seg) { changed = true; reasons.push('lowercased'); } seg = l; }
    if (!SLUG_RULES.pattern.test(seg)) {
      const fixed = slugify(seg);
      if (fixed !== seg) { changed = true; reasons.push(`"${seg}" → "${fixed}"`); }
      seg = fixed;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  if (Buffer.byteLength(joined) > SLUG_RULES.maxKeyBytes) throw new Error(`path exceeds ${SLUG_RULES.maxKeyBytes} bytes: ${joined.slice(0, 80)}…`);
  return { path: joined, changed, reason: reasons.length ? reasons.join('; ') : undefined };
}

/** Heading id as the renderer computes it: github-slugger, then dashes collapsed. */
export function headingSlug(text: string, slugger = new GithubSlugger()): string {
  return slugger.slug(text).replace(/-{2,}/g, '-');
}
