/** ReadMe's public RFC 9727 API catalog; unavailable specs are reported, never guessed. */
export function readmeCatalogSpecs(body: string, catalogUrl: string): string[] {
  const root = JSON.parse(body) as { linkset?: unknown };
  if (!Array.isArray(root.linkset)) throw new Error('ReadMe API catalog has no linkset array');
  const urls: string[] = [];
  for (const value of root.linkset) {
    if (!value || typeof value !== 'object') throw new Error('ReadMe API catalog has an invalid linkset entry');
    const entry = value as Record<string, unknown>;
    const descriptions = entry['service-desc'];
    if (descriptions === undefined) continue;
    if (!Array.isArray(descriptions)) throw new Error('ReadMe service-desc must be an array');
    for (const description of descriptions) {
      const link = description as { href?: unknown };
      if (typeof link?.href !== 'string') throw new Error('ReadMe catalog spec link has no href');
      const url = new URL(link.href, catalogUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('ReadMe catalog spec must be a credential-free HTTP URL');
      urls.push(url.toString());
    }
  }
  return [...new Set(urls)];
}
