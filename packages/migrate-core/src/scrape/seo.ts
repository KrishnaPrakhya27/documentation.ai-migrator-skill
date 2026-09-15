/**
 * The search metadata a page states about itself.
 *
 * A migration that keeps the words but loses the metadata costs the customer search traffic on the
 * day the domain moves, which is the one moment they cannot afford it. None of it was captured:
 * every migrated page carried `title` and nothing else.
 *
 * Read from the frozen HTML rather than at acquisition, so it costs no request, works on
 * workspaces captured before this existed, and gives verification the same derivation from the
 * same bytes.
 */
import { parseHtml, findAll } from '../ir/from-html.js';

export interface SourceSeo {
  /** `<link rel="canonical">`, absolute against the page it was served from. */
  canonical?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  /** `<meta name="robots">`: noindex here is a publishing decision, not styling. */
  robots?: string;
}

/** Attribute lookup over the whole document: these tags live in <head>, which the parser keeps. */
function metaContent(html: ReturnType<typeof parseHtml>, attribute: 'name' | 'property', value: string): string | undefined {
  for (const tag of findAll(html, 'meta')) {
    if ((tag.attribs[attribute] ?? '').toLowerCase() !== value) continue;
    const content = (tag.attribs.content ?? '').trim();
    if (content) return content;
  }
  return undefined;
}

function absolute(url: string | undefined, pageUrl: string): string | undefined {
  if (!url) return undefined;
  try { return new URL(url, pageUrl).toString(); } catch { return url; }
}

/** What the rendered page states about itself for search engines and link previews. */
export function extractSeo(html: string, pageUrl: string): SourceSeo {
  const root = parseHtml(html);
  const canonicalTag = findAll(root, 'link').find((tag) => (tag.attribs.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'));
  const seo: SourceSeo = {
    canonical: absolute(canonicalTag?.attribs.href?.trim(), pageUrl),
    ogTitle: metaContent(root, 'property', 'og:title') ?? metaContent(root, 'name', 'og:title'),
    ogDescription: metaContent(root, 'property', 'og:description') ?? metaContent(root, 'name', 'og:description'),
    ogImage: absolute(metaContent(root, 'property', 'og:image') ?? metaContent(root, 'name', 'og:image'), pageUrl),
    robots: metaContent(root, 'name', 'robots'),
  };
  for (const key of Object.keys(seo) as Array<keyof SourceSeo>) if (seo[key] === undefined) delete seo[key];
  return seo;
}

/** The page's own address, as the source served it, for deciding whether a canonical points elsewhere. */
function sameTarget(a: string, b: string): boolean {
  const identity = (value: string): string => {
    const url = new URL(value);
    const path = url.pathname.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '');
    // URL schemes and hostnames are case-insensitive; paths generally are not. Lowercasing the
    // whole URL hid a source canonical that deliberately distinguished /Guide from /guide.
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
  };
  try { return identity(a) === identity(b); } catch { return a.replace(/[?#].*$/, '') === b.replace(/[?#].*$/, ''); }
}

export interface SeoFrontmatter {
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  canonical?: string;
}

/**
 * The frontmatter this page must carry to keep stating what the source stated.
 *
 * Two rules are deliberate. A page that points its canonical at itself carries none: the migrated
 * page self-canonicalises on its own domain, and copying the old address would tell search engines
 * the customer's dead site is the real one. A page that points somewhere else carries that
 * relationship, rewritten to wherever that target now lives, because a group of duplicate pages
 * naming a primary is a statement the source made about its own content.
 *
 * `metaTitle` and `metaDescription` are written only when the source stated something other than
 * the page's own title and description, so an unchanged page carries no redundant frontmatter.
 */
/**
 * Whether this social card came from the platform's own generator. The generator is usually reached
 * through an image proxy, so its path arrives percent-encoded inside a query string and the decoded
 * form has to be tested as well as the raw one.
 */
function isGeneratedCard(url: string, generator?: string): boolean {
  if (!generator) return false;
  if (url.includes(generator)) return true;
  try { return decodeURIComponent(url).includes(generator); } catch { return false; }
}

export function seoFrontmatter(seo: SourceSeo, page: { url: string; title?: string; description?: string }, retarget: (url: string) => string | undefined, generatedOgImage?: string): SeoFrontmatter {
  const out: SeoFrontmatter = {};
  if (seo.ogTitle && seo.ogTitle !== page.title) out.metaTitle = seo.ogTitle;
  if (seo.ogDescription && seo.ogDescription !== page.description) out.metaDescription = seo.ogDescription;
  // A social card the source builds from the page's own title, description and *its own theme* is
  // the platform's branding, not the page's content - the same reason a logo, favicon and colours
  // are recorded and never carried. The migrated site states its own. An ogImage the author chose
  // is a statement about the page and is carried as before.
  if (seo.ogImage && !isGeneratedCard(seo.ogImage, generatedOgImage)) out.ogImage = seo.ogImage;
  if (seo.canonical && !sameTarget(seo.canonical, page.url)) out.canonical = retarget(seo.canonical) ?? seo.canonical;
  for (const key of Object.keys(out) as Array<keyof SeoFrontmatter>) if (out[key] === undefined) delete out[key];
  return out;
}
