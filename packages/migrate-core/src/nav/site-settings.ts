/**
 * The site-level settings a migration writes into documentation.json.
 *
 * A migration carries the documentation, not the source platform's branding. The
 * source's logo, favicon, colours and theme are recorded in inventory/platform-meta.json
 * as evidence, but the migrated site shows Documentation.AI's own: the renderer falls
 * back to it whenever these keys are absent. They do not share a shape either: Mintlify's
 * `logo` is a light/dark object and its `colors` a flat primary/light/dark triple, where
 * Documentation.AI reads `logo-dark`/`logo-light` strings and per-mode colour objects.
 */

/** Keys of documentation.json that hold branding. None is ever written from a source. */
export const SOURCE_BRANDING_KEYS = ['logo', 'logo-dark', 'logo-light', 'logo-small-dark', 'logo-small-light', 'favicon', 'colors', 'theme'] as const;

type BrandingKey = (typeof SOURCE_BRANDING_KEYS)[number];

export interface DocumentationSiteSettings { name?: string }

/** The site identity a migration carries: the documentation's name, and nothing that brands it. */
export function documentationSiteSettings(meta: { name?: unknown }): DocumentationSiteSettings {
  return typeof meta.name === 'string' && meta.name ? { name: meta.name } : {};
}

/** A documentation.json from an earlier run, with any branding that run carried removed. */
export function withoutSourceBranding<T extends Record<string, unknown>>(config: T): Omit<T, BrandingKey> {
  const branding = new Set<string>(SOURCE_BRANDING_KEYS);
  return Object.fromEntries(Object.entries(config).filter(([key]) => !branding.has(key))) as Omit<T, BrandingKey>;
}
