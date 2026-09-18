/**
 * The site plan (`plan/site.yaml`): how the migrated site presents itself.
 *
 * Everything the other plans hold is content or structure, and must be the source's. This one is
 * presentation, which may differ and which a person decides: whether the site carries the source's
 * brand colour, logo and favicon; what its top bar links to; which template it uses; whether the
 * migration's own finishing stylesheet ships with it. `plan` proposes it from what the source
 * states about itself, a person reviews it at gate 2 with the other plans, and `nav` writes it into
 * documentation.json through the platform's own settings, checked against the platform's own schema.
 *
 * A logo or favicon is written only as a URL the migration hosts. In exact mode nothing in the
 * output points at the source host, so an image that could not be hosted is left out and said so.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { NavbarLink, SiteBranding } from '../scrape/site-branding.js';
import { hexColor } from '../scrape/site-branding.js';
import { ICON_POLICIES, type IconPolicy } from './icon-suggest.js';

export interface SitePlan {
  branding: {
    /** false writes none of the source's brand: the site opens in the platform's default colours under its name as text. */
    carry: boolean;
    colors?: { light?: string; dark?: string };
    logo?: { light?: string; dark?: string };
    favicon?: { light?: string; dark?: string };
  };
  navbar?: { primary?: NavbarLink; links?: NavbarLink[] };
  seo?: Record<string, string | boolean>;
  /** `classic` (sidebar layout) or `atlas` (denser navigation, content on a card). */
  template?: 'classic' | 'atlas';
  /**
   * Sidebar icons. `suggested` proposes one from an entry's own title wherever the source states
   * none, which is how documentation written on the platform reads; `source` writes only what the
   * source states; `none` writes no icon at all.
   */
  icons?: IconPolicy;
  /** Ship `styles/migration.css`: the few rules that finish what the migration wrote (badges, images without captions). */
  stylesheet: boolean;
  /** Old addresses redirect to the pages that replace them, through the platform's own `redirects` setting. */
  redirects: boolean;
  /** What the source states that the platform has no setting for. For the reviewer; never written. */
  notCarried?: string[];
}

export const SITE_PLAN_FILE = 'site.yaml';
export const MIGRATION_STYLESHEET = 'styles/migration.css';

const HEADER = `# How the migrated site presents itself. None of this is content: change anything here freely.
# Proposed from what the source states about itself; reviewed at gate 2 with the other plans.
#
#   branding.carry   false leaves the source's colours, logo and favicon out (the platform's defaults apply).
#                    Decide this for a demo of someone else's documentation.
#   branding.colors  the brand colour per colour scheme, as #rrggbb
#   branding.logo / favicon   source URLs; the assets stage hosts them, and nav writes the hosted URL
#   navbar           primary is the call-to-action button; links are the top bar's other links
#   template         classic | atlas
#   icons            sidebar icons: suggested | source | none
#                    suggested proposes one from each entry's own title where the source states none,
#                    which is how documentation written on the platform reads. An icon the source
#                    states is always kept as it states it. Set source to carry only those, or none
#                    for a sidebar of plain text. Edit any icon below in documentation.json after nav.
#   stylesheet       ship styles/migration.css with the site (badges, images the source shows without a caption)
#   redirects        write the old-address redirects into documentation.json
`;

/** The plan `plan` proposes: the source's own statements, with nothing a person has yet decided. */
export function proposeSitePlan(branding: SiteBranding | undefined, chosen: { template?: 'classic' | 'atlas' } = {}): SitePlan {
  const navbar = branding?.navbar && (branding.navbar.primary || branding.navbar.links?.length) ? branding.navbar : undefined;
  return {
    branding: {
      carry: true,
      ...(branding?.colors ? { colors: branding.colors } : {}),
      ...(branding?.logo?.light || branding?.logo?.dark ? { logo: { ...(branding.logo.light ? { light: branding.logo.light } : {}), ...(branding.logo.dark ? { dark: branding.logo.dark } : {}) } } : {}),
      ...(branding?.favicon ? { favicon: branding.favicon } : {}),
    },
    ...(navbar ? { navbar } : {}),
    ...(branding?.seo && Object.keys(branding.seo).length ? { seo: branding.seo } : {}),
    template: chosen.template ?? 'classic',
    icons: 'suggested',
    stylesheet: true,
    redirects: true,
    ...(branding?.unsupported?.length ? { notCarried: branding.unsupported } : {}),
  };
}

export function sitePlanPath(workspace: string): string {
  return join(workspace, 'plan', SITE_PLAN_FILE);
}

export function writeSitePlan(workspace: string, plan: SitePlan): void {
  writeFileSync(sitePlanPath(workspace), `${HEADER}${toYaml(plan)}`, { mode: 0o600 });
}

/** The reviewed plan, or undefined for a workspace planned before there was one (nothing beyond the name is then written). */
export function readSitePlan(workspace: string): SitePlan | undefined {
  const path = sitePlanPath(workspace);
  if (!existsSync(path)) return undefined;
  const parsed = parseYaml(readFileSync(path, 'utf8')) as Partial<SitePlan> | null;
  if (!parsed || typeof parsed !== 'object') throw new Error(`${path} is not a YAML mapping`);
  if (parsed.template !== undefined && parsed.template !== 'classic' && parsed.template !== 'atlas') throw new Error(`${path}: template must be classic or atlas`);
  if (parsed.icons !== undefined && !ICON_POLICIES.includes(parsed.icons)) throw new Error(`${path}: icons must be ${ICON_POLICIES.join(', ')}`);
  for (const scheme of ['light', 'dark'] as const) {
    const colour = parsed.branding?.colors?.[scheme];
    if (colour !== undefined && !hexColor(colour)) throw new Error(`${path}: branding.colors.${scheme} "${String(colour)}" is not a colour; write it as #rrggbb`);
  }
  // A workspace planned before there was an icons setting reads as `source`: a re-run of nav on it
  // must write the same file it wrote before, rather than quietly restyling a reviewed sidebar.
  return { ...parsed, branding: { ...parsed.branding, carry: parsed.branding?.carry !== false }, icons: parsed.icons ?? 'source', stylesheet: parsed.stylesheet !== false, redirects: parsed.redirects !== false } as SitePlan;
}

/** Every image the plan asks the site to show, so the assets stage can host it with the pages' own media. */
export function sitePlanImages(plan: SitePlan | undefined): string[] {
  if (!plan?.branding.carry) return [];
  return [...new Set([plan.branding.logo?.light, plan.branding.logo?.dark, plan.branding.favicon?.light, plan.branding.favicon?.dark].filter((url): url is string => typeof url === 'string' && /^https?:\/\//.test(url)))];
}

export interface SiteSettingsInput {
  name?: unknown;
  plan?: SitePlan;
  /** The hosted URL of a source image, or undefined when the migration does not host it. */
  hosted?: (sourceUrl: string) => string | undefined;
  redirects?: ReadonlyArray<{ source: string; destination: string; statusCode?: number }>;
}

/** SEO keys the platform's schema accepts for site-level statements a source makes about itself. */
const SEO_KEYS = new Set(['twitter:site', 'twitter:creator', 'twitter:card', 'og:locale', 'og:type', 'siteName', 'defaultDescription']);

/**
 * The top-level documentation.json settings for this migration, and what was left out and why. The
 * name always travels. The rest is the reviewed site plan, written under the platform's own keys:
 * `colors.{light,dark}.brand`, `logo-light`/`logo-dark`, `favicon`, `navbar.actions`, `seo`,
 * `template`, `customCss`, `redirects`.
 */
export function documentationSiteSettings(input: SiteSettingsInput): { settings: Record<string, unknown>; leftOut: string[] } {
  const settings: Record<string, unknown> = {};
  const leftOut: string[] = [];
  if (typeof input.name === 'string' && input.name) settings.name = input.name;
  const plan = input.plan;
  if (!plan) return { settings, leftOut };
  if (plan.template) settings.template = plan.template;
  if (plan.branding.carry) {
    const light = hexColor(plan.branding.colors?.light); const dark = hexColor(plan.branding.colors?.dark);
    if (light || dark) settings.colors = { ...(light ? { light: { brand: light } } : {}), ...(dark ? { dark: { brand: dark } } : {}) };
    const image = (key: string, source: string | undefined, what: string): void => {
      if (!source) return;
      const url = input.hosted?.(source);
      if (url) settings[key] = url;
      else leftOut.push(`${what}: ${source} is not hosted by this migration, so it is not written (run assets with a hosting provider)`);
    };
    // one logo serves both schemes when the source draws only one
    image('logo-light', plan.branding.logo?.light ?? plan.branding.logo?.dark, 'logo (light)');
    image('logo-dark', plan.branding.logo?.dark ?? plan.branding.logo?.light, 'logo (dark)');
    image('favicon', plan.branding.favicon?.light ?? plan.branding.favicon?.dark, 'favicon');
  }
  const primary = plan.navbar?.primary; const links = plan.navbar?.links?.filter((link) => link.title && link.link) ?? [];
  if (primary?.title && primary.link || links.length) settings.navbar = { actions: { ...(primary?.title && primary.link ? { primary: { title: primary.title, link: primary.link } } : {}), ...(links.length ? { links: links.map(({ title, link }) => ({ title, link })) } : {}) } };
  const seo = Object.fromEntries(Object.entries(plan.seo ?? {}).filter(([key, value]) => SEO_KEYS.has(key) && (typeof value === 'string' ? value.trim() : typeof value === 'boolean')));
  if (Object.keys(seo).length) settings.seo = seo;
  if (plan.stylesheet) settings.customCss = [{ src: MIGRATION_STYLESHEET }];
  if (plan.redirects && input.redirects?.length) {
    // The site's root is `initialRoute`'s to open. A rule whose source is the root would answer every
    // visit to the site with a permanent redirect, which browsers remember, to say what the
    // platform already does.
    const redirects = input.redirects.filter((rule) => rule.source !== rule.destination && rule.source.replace(/\/+$/, '') !== '').map((rule) => ({ source: rule.source, destination: rule.destination, ...(rule.statusCode && rule.statusCode !== 308 ? { statusCode: rule.statusCode } : {}) }));
    if (redirects.length) settings.redirects = redirects;
  }
  return { settings, leftOut };
}

/**
 * The stylesheet that finishes what the migration wrote. Every rule is scoped to a `dai-mig-` hook
 * the migration itself emits, so nothing here restyles the platform or a page written later in the
 * editor; colours come from the site's own theme variables, so it follows the brand and dark mode.
 */
export const MIGRATION_STYLESHEET_CSS = `/*
 * Finishing rules for content written by the Documentation.AI migrator.
 * Scoped to dai-mig-* hooks the migration emits. Safe to edit or remove.
 */

/* A badge the source drew inline (Mintlify <Badge>, a "Deprecated" pill). */
.dai-mig-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.05em 0.6em;
  margin: 0 0.15em;
  border-radius: 999px;
  font-size: 0.75em;
  font-weight: 600;
  line-height: 1.7;
  letter-spacing: 0.01em;
  white-space: nowrap;
  vertical-align: middle;
  color: var(--brand);
  background: color-mix(in srgb, var(--brand) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand) 25%, transparent);
}

/* The source showed this image without a caption: its alt text is for screen readers, not for print. */
figure.dai-mig-no-caption > figcaption {
  display: none;
}

/* A picture the source drew behind its landing page's heading: decoration, not an illustration. */
figure.dai-mig-decorative {
  margin: 0 !important;
  pointer-events: none;
  user-select: none;
}
figure.dai-mig-decorative [data-rmiz-content] {
  cursor: default;
}
`;
