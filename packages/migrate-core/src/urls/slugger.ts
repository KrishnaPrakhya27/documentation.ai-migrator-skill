/**
 * Slug rules matching the platform: kebab-case segments, lowercase, and the
 * heading slugger the renderer uses (github-slugger with dashes collapsed).
 */
import GithubSlugger from 'github-slugger';
import { SLUG_RULES, isValidSlugSegment } from '@dai/content-contract';

export function slugify(input: string): string {
  return slugifySegment(input).slug;
}

/**
 * The slug, and whether making it erased the segment entirely.
 *
 * The platform's paths are ASCII kebab-case, so an accented Latin title transliterates cleanly
 * ("Guía" becomes "guia"). A title written in another script has nothing to transliterate to and
 * comes out empty, which used to fall back to the literal "page": a Japanese or Russian site then
 * migrated as page, page-2, page-3, losing every URL it had while reporting nothing. `erased`
 * says that happened, so the stage can stop and ask for a path instead of inventing one.
 */
export function slugifySegment(input: string, opts: { case?: 'preserve' | 'lower' } = {}): { slug: string; erased: boolean } {
  const folded = input.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // A path keeps the case its site served it under: `/Procedures/Composer` is that page's address,
  // and lowercasing it would break every link the customer has published to it.
  const slug = (opts.case === 'preserve' ? folded : folded.toLowerCase())
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  // Something was written here, and none of it survived: that is erasure, not an empty segment.
  const erased = !slug && /[\p{L}\p{N}]/u.test(input);
  return { slug: slug || 'page', erased };
}

/** Path → legal DAI path, preserving case only when allowed. Returns the change reason when altered. */
export function legalisePath(path: string, opts: { case: 'preserve' | 'lower' }): { path: string; changed: boolean; reason?: string; erased?: string[] } {
  const segs = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const out: string[] = [];
  let changed = false; const reasons: string[] = []; const erased: string[] = [];
  for (const s of segs) {
    let seg = decodeURIComponent(s);
    if (opts.case === 'lower') { const l = seg.toLowerCase(); if (l !== seg) { changed = true; reasons.push('lowercased'); } seg = l; }
    if (!isValidSlugSegment(seg, opts)) {
      const fixed = slugifySegment(seg, opts);
      if (fixed.erased) erased.push(seg);
      if (fixed.slug !== seg) { changed = true; reasons.push(`"${seg}" → "${fixed.slug}"`); }
      seg = fixed.slug;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  if (Buffer.byteLength(joined) > SLUG_RULES.maxKeyBytes) throw new Error(`path exceeds ${SLUG_RULES.maxKeyBytes} bytes: ${joined.slice(0, 80)}…`);
  return { path: joined, changed, reason: reasons.length ? reasons.join('; ') : undefined, ...(erased.length ? { erased } : {}) };
}

/** Heading id as the renderer computes it: github-slugger, then dashes collapsed. */
export function headingSlug(text: string, slugger = new GithubSlugger()): string {
  // Space around a heading is not part of its name. A Flare topic that wrote "Steps " would
  // otherwise be asked for `#steps-` while every renderer, reading the heading as trimmed text,
  // gives it `#steps` — and every link to it would land nowhere.
  return slugger.slug(text.trim()).replace(/-{2,}/g, '-');
}
