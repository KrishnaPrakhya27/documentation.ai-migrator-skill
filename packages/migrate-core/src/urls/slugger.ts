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

/**
 * The id GitBook gives a heading, read from the links GitBook's own site writes: "3. Payment terms"
 * is linked as `#id-3.-payment-terms` and "Edit on GitHub/GitLab" as `#edit-on-github-gitlab`.
 * Lowercase; any run of characters other than letters, digits and dots becomes one dash; an id that
 * would begin with a digit is prefixed `id-`. Some of GitBook's links omit the dots (`#a-how-does-
 * this-work`), so `gitbookHeadingIds` offers that spelling too.
 */
export function gitbookHeadingId(text: string): string {
  // `&` is spelled "and" (`Math & TeX` → `math-and-tex`); a dot inside stays, a dot at either end
  // is trimmed with the hyphens (`3. Payment Terms.` → `id-3.-payment-terms`)
  const slug = text.trim().toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}.]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '');
  return /^\d/.test(slug) ? `id-${slug}` : slug;
}

/**
 * Every id GitBook has been seen to give a heading, the current rule first. Its slugger has changed
 * over time and a site carries links in each spelling: an apostrophe once became a hyphen and now
 * vanishes (`GitBook's` → `gitbooks`), a run of capitals is now split letter by letter
 * (`Azure AD` → `azure-a-d`), and a dot inside a heading is kept or dropped. Measured against 92
 * in-page links on gitbook.com: the base rule alone lands 88, the variants the rest. Every spelling
 * is an alias, so whichever a link used gets its shim.
 */
export function gitbookHeadingIds(text: string): string[] {
  const spellings = new Set<string>();
  for (const apostrophe of [text, text.replace(/[\u2019']/g, '')]) {
    for (const capitals of [apostrophe, apostrophe.replace(/(?<=\p{Lu})(?=\p{Lu})/gu, '-')]) {
      const dotted = gitbookHeadingId(capitals);
      spellings.add(dotted);
      spellings.add(dotted.replace(/\.+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, ''));
    }
  }
  return [...spellings].filter(Boolean);
}

/** Heading id as the renderer computes it: github-slugger, then dashes collapsed. */
export function headingSlug(text: string, slugger = new GithubSlugger()): string {
  // Space around a heading is not part of its name. A Flare topic that wrote "Steps " would
  // otherwise be asked for `#steps-` while every renderer, reading the heading as trimmed text,
  // gives it `#steps` — and every link to it would land nowhere.
  return slugger.slug(text.trim()).replace(/-{2,}/g, '-');
}

/**
 * The id Mintlify's renderer gives a heading, read from 9,773 rendered headings across one site:
 * lowercase, backticks dropped, runs of whitespace, dots and hyphens become one hyphen, and the
 * characters `( ) , * :` are removed after that (so `Étape 1 : Installer` keeps the two hyphens the
 * spaces around the colon became). Everything else — apostrophes, `/`, `_`, `$`, `&`, CJK
 * punctuation — stays. A repeated heading on one page takes `-2`, `-3`: the caller counts.
 */
export function mintlifyHeadingId(text: string): string {
  return text
    .replace(/\u200b/g, '')
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[\s.\-]+/g, '-')
    .replace(/[(),*:"“”]/g, '')
    .replace(/^-+|-+$/g, '');
}
