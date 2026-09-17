/**
 * A label for a container the source never named.
 *
 * A page the sidebar does not place is filed by the folders its address sits in, and a folder has
 * only a slug: `help-center`. Written as `help center` it sits beside "Documentation" and
 * "API reference" looking like a mistake, which it is — the casing is ours, not the source's.
 * Where the source itself names a container with that slug anywhere in its navigation (a hidden
 * "Help center" tab), that is the label. Otherwise the slug is read as words in sentence case,
 * with the abbreviations documentation sites write in capitals written in capitals.
 */
import { slugify } from '../urls/slugger.js';

/** Abbreviations that are unambiguous as whole words in a documentation path, as they are written. */
const ABBREVIATIONS: Record<string, string> = Object.fromEntries([
  ...['api', 'sdk', 'cli', 'faq', 'sso', 'saml', 'jwt', 'url', 'http', 'https', 'json', 'xml', 'yaml', 'css', 'html', 'sql', 'mcp', 'llm', 'dns', 'tls', 'ssl', 'ai', 'ui', 'ux', 'ci', 'cd', 'ip', 'seo', 'pdf', 'csv', 'oidc', 'scim', 'rbac', 'gdpr', 'sla'].map((word) => [word, word.toUpperCase()]),
  ...['api', 'sdk', 'faq', 'url', 'llm'].map((word) => [`${word}s`, `${word.toUpperCase()}s`]),
]);

/** The words of one path segment, as a label: `help-center` → `Help center`, `api_reference` → `API reference`. */
export function labelFromPathSegment(segment: string, stated?: ReadonlyMap<string, string>): string {
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch { /* kept as served */ }
  const named = stated?.get(slugify(decoded));
  if (named) return named;
  const words = decoded.replace(/[-_]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  // A segment that already carries capitals was cased by whoever named it (`MyProduct`, `OAuth`).
  if (words.some((word) => /\p{Lu}/u.test(word))) return words.join(' ');
  return words.map((word, index) => ABBREVIATIONS[word] ?? (index === 0 ? word.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase()) : word)).join(' ');
}

/** Every container label a navigation states, by slug, so a folder the source also names takes that name. First statement wins. */
export function statedLabelsBySlug(nodes: ReadonlyArray<{ type: string; label?: string; children?: unknown }>): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (items: ReadonlyArray<{ type: string; label?: string; children?: unknown }>): void => {
    for (const node of items) {
      if (node.type !== 'group' || typeof node.label !== 'string') continue;
      const slug = slugify(node.label);
      if (slug && !out.has(slug)) out.set(slug, node.label);
      if (Array.isArray(node.children)) walk(node.children as ReadonlyArray<{ type: string; label?: string; children?: unknown }>);
    }
  };
  walk(nodes);
  return out;
}
