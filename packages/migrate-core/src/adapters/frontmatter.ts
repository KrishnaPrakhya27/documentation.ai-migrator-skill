/**
 * The scalar frontmatter a page states about itself.
 *
 * Adapters read a handful of declared values — a title, a slug, a position — and nothing else.
 * Only plain scalars are read: a value that needs YAML semantics to interpret is left unread rather
 * than guessed at, so an adapter never reports a structure the source did not state.
 */
export function statedFrontmatter(body: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1];
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):[ \t]*(.+)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
    if (value) out[match[1]] = value;
  }
  return out;
}

/** The first `# heading` of a page, which several platforms use as the title when frontmatter states none. */
export function firstHeading(body: string): string | undefined {
  const withoutFrontmatter = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return /^#\s+(.+?)\s*$/m.exec(withoutFrontmatter)?.[1];
}

/** A filename read as a title: separators become spaces, and a numeric ordering prefix is not part of the name. */
export function titleFromFilename(name: string): string {
  return name.replace(/\.mdx?$/i, '').replace(/^\d+[-_.]/, '').replace(/[-_]+/g, ' ').trim();
}
