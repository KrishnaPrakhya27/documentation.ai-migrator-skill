/**
 * How a source site presents itself: its brand colour, its logo and favicon, the links and the
 * call-to-action in its top bar, what it tells search engines about itself.
 *
 * None of this is documentation content, and none of it is the source *platform's* look. It is the
 * customer's own brand, stated in their own configuration, and a migrated site that drops it opens
 * in somebody else's colours under a text logo. It is read from bytes the capture already holds —
 * the configuration a Mintlify page embeds, the header and head a GitBook page renders — so it
 * costs no request, and it is proposed in `plan/site.yaml` for a person to review, never applied
 * unseen: whether a demo of a third party's documentation should wear their logo is a decision.
 */
import { parseDocument } from 'htmlparser2';
import { findAll, getAttributeValue, textContent } from 'domutils';
import type { Element } from 'domhandler';

export interface SiteBranding {
  /** Where this was read from, so a reviewer knows how far to trust it. */
  evidence: 'mintlify-config' | 'gitbook-rendered' | 'rendered-page';
  name?: string;
  description?: string;
  /** The brand colour per colour scheme, as `#rrggbb`. */
  colors?: { light?: string; dark?: string };
  logo?: { light?: string; dark?: string; href?: string };
  favicon?: { light?: string; dark?: string };
  navbar?: { primary?: NavbarLink; links?: NavbarLink[] };
  /** Site-level SEO statements, in the platform's own keys (`twitter:site`, `og:locale`…). */
  seo?: Record<string, string | boolean>;
  /** What the source states that the platform has no place for; reported, never written. */
  unsupported?: string[];
}

export interface NavbarLink { title: string; link: string }

const HEX6 = /^#[0-9a-f]{6}$/i;

/** `#abc`, `#aabbcc`, `rgb(1 2 3)`, `1 2 3` → `#rrggbb`; anything else is not a colour this can state. */
export function hexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (HEX6.test(text)) return text.toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const rgb = /^(?:rgba?\()?\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(text);
  if (rgb && rgb.slice(1, 4).every((part) => Number(part) <= 255)) return `#${rgb.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
  return undefined;
}

const text = (node: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = node?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const compact = <T extends Record<string, unknown>>(value: T): T | undefined => {
  const kept = Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined && !(Array.isArray(entry[1]) && !entry[1].length)));
  return Object.keys(kept).length ? kept as T : undefined;
};

/** A light/dark pair that a config states either as one URL or as `{ light, dark }`. */
function pair(value: unknown): { light?: string; dark?: string } | undefined {
  if (typeof value === 'string' && value.trim()) return { light: value.trim() };
  const node = record(value);
  if (!node) return undefined;
  return compact({ light: text(node, 'light') ?? text(node, 'default'), dark: text(node, 'dark') });
}

/**
 * Branding from a Mintlify `docs.json`, whether read from the repository or from the copy every
 * live page embeds. Mintlify's `colors.primary` is what it draws with in light mode and
 * `colors.light` what it draws with in dark mode (a lighter shade, for a dark background);
 * `colors.dark` is a hover shade with no counterpart.
 */
export function mintlifyBranding(config: Record<string, unknown>): SiteBranding | undefined {
  const colors = record(config.colors);
  const navbar = record(config.navbar);
  const links = (Array.isArray(navbar?.links) ? navbar!.links as unknown[] : []).flatMap((item): NavbarLink[] => {
    const link = record(item);
    const title = text(link, 'label') ?? text(link, 'name'); const href = text(link, 'href') ?? text(link, 'url');
    return title && href ? [{ title, link: href }] : [];
  });
  const primaryNode = record(navbar?.primary) ?? record(config.topbarCtaButton);
  // a `github` primary states only the repository; its label is the platform's, not the site's
  const primary = primaryNode && (text(primaryNode, 'label') ?? text(primaryNode, 'name')) && (text(primaryNode, 'href') ?? text(primaryNode, 'url'))
    ? { title: (text(primaryNode, 'label') ?? text(primaryNode, 'name'))!, link: (text(primaryNode, 'href') ?? text(primaryNode, 'url'))! } : undefined;
  const metatags = record(record(config.seo)?.metatags) ?? record(config.metadata);
  const seo: Record<string, string | boolean> = {};
  for (const key of ['twitter:site', 'twitter:creator', 'twitter:card', 'og:locale', 'og:type'] as const) { const value = text(metatags, key); if (value) seo[key] = value; }
  const logo = pair(config.logo);
  const logoHref = text(record(config.logo), 'href');
  const unsupported: string[] = [];
  if (record(config.footer)) unsupported.push('footer (social links and link columns): the platform has no footer setting');
  if (config.fonts) unsupported.push('fonts: the platform sets its own typography; a custom stylesheet can change it');
  if (record(config.banner)) unsupported.push('banner: the platform has no announcement banner');
  if (config.background) unsupported.push('background decoration: no counterpart');
  const branding = compact({
    name: text(config, 'name'),
    description: text(config, 'description'),
    colors: compact({ light: hexColor(colors?.primary), dark: hexColor(colors?.light) ?? hexColor(colors?.primary) }),
    logo: logo || logoHref ? compact({ ...logo, href: logoHref }) : undefined,
    favicon: pair(config.favicon),
    navbar: compact({ primary, links }),
    seo: Object.keys(seo).length ? seo : undefined,
    unsupported,
  });
  return branding ? { evidence: 'mintlify-config', ...branding } : undefined;
}

const attr = (node: Element, name: string): string => (getAttributeValue(node, name) ?? '').trim();
const absolute = (href: string, base: string): string | undefined => { try { return new URL(href.replace(/&amp;/g, '&'), base).toString(); } catch { return undefined; } };
const classTokens = (node: Element): Set<string> => new Set(attr(node, 'class').split(/\s+/).filter(Boolean));
/** Which colour scheme a picture is drawn for, by the utility classes every Tailwind-built theme uses for a light/dark pair. */
const schemeOf = (node: Element): 'light' | 'dark' | undefined => {
  const classes = classTokens(node);
  if (classes.has('dark:hidden')) return 'light';
  if (classes.has('hidden') && (classes.has('dark:block') || classes.has('dark:inline') || classes.has('dark:flex'))) return 'dark';
  return undefined;
};

/**
 * Branding a rendered page states about its site: the favicon its head links (per colour scheme
 * where it says so), the logo its header draws, the theme colour, its Open Graph and Twitter site
 * statements. `primaryVariable` names a CSS custom property holding the brand colour on platforms
 * that publish one (GitBook's `--primary-original`).
 */
export function renderedBranding(html: string, pageUrl: string, options: { evidence?: SiteBranding['evidence']; primaryVariable?: string; headerLinks?: boolean } = {}): SiteBranding | undefined {
  const dom = parseDocument(html);
  const all = (name: string): Element[] => findAll((node) => node.name === name, dom.children);
  const favicon: { light?: string; dark?: string } = {};
  for (const link of all('link')) {
    if (!/(?:^|\s)icon(?:\s|$)/i.test(attr(link, 'rel')) || /apple-touch/i.test(attr(link, 'rel'))) continue;
    const href = absolute(attr(link, 'href'), pageUrl);
    if (!href) continue;
    const scheme = /dark/i.test(attr(link, 'media')) ? 'dark' : 'light';
    favicon[scheme] ??= href;
  }
  const meta = (key: string): string | undefined => {
    const node = all('meta').find((item) => attr(item, 'name').toLowerCase() === key || attr(item, 'property').toLowerCase() === key);
    const value = node ? attr(node, 'content') : '';
    return value || undefined;
  };
  // The logo is the picture the header draws: alone in the header, or called a logo by its alt or class.
  const header = all('header')[0];
  const logo: { light?: string; dark?: string; href?: string } = {};
  if (header) {
    const images = findAll((node) => node.name === 'img', header.children).filter((img) => /logo/i.test(`${attr(img, 'alt')} ${attr(img, 'class')} ${attr(img, 'src')}`));
    for (const img of images) {
      const src = absolute(attr(img, 'src'), pageUrl);
      if (!src) continue;
      logo[schemeOf(img) ?? 'light'] ??= src;
    }
  }
  let brand: string | undefined;
  if (options.primaryVariable) {
    const match = new RegExp(`${options.primaryVariable.replace(/[-]/g, '\\-')}\\s*:\\s*([^;}]+)`).exec(html);
    brand = hexColor(match?.[1]);
  }
  brand ??= hexColor(meta('theme-color'));
  const seo: Record<string, string | boolean> = {};
  for (const key of ['twitter:site', 'twitter:creator', 'og:locale'] as const) { const value = meta(key); if (value) seo[key] = value; }
  // The header's own links out of the documentation: the top bar's links, its last button-like one the call to action.
  let navbar: SiteBranding['navbar'];
  if (header && options.headerLinks) {
    const origin = new URL(pageUrl).origin;
    const links = findAll((node) => node.name === 'a', header.children).flatMap((anchor): Array<NavbarLink & { button: boolean }> => {
      const href = absolute(attr(anchor, 'href'), pageUrl);
      const title = textContent(anchor).replace(/\s+/g, ' ').trim();
      if (!href || !title || href.startsWith(`${origin}/`) && new URL(href).pathname.startsWith(new URL(pageUrl).pathname.split('/').slice(0, 2).join('/'))) return [];
      if (findAll((node) => node.name === 'img', anchor.children).length) return [];
      return [{ title, link: href, button: /\bbutton\b|bg-primary|btn/i.test(attr(anchor, 'class')) }];
    });
    const unique = links.filter((link, index) => links.findIndex((other) => other.link === link.link) === index);
    const primary = [...unique].reverse().find((link) => link.button);
    navbar = compact({
      primary: primary ? { title: primary.title, link: primary.link } : undefined,
      links: unique.filter((link) => link !== primary).map(({ title, link }) => ({ title, link })),
    });
  }
  const branding = compact({
    name: meta('og:site_name'),
    colors: brand ? { light: brand, dark: brand } : undefined,
    logo: compact(logo),
    favicon: compact(favicon),
    navbar,
    seo: Object.keys(seo).length ? seo : undefined,
  });
  return branding ? { evidence: options.evidence ?? 'rendered-page', ...branding } : undefined;
}

/** Branding for a live site of a given platform, from one of its rendered pages (the home page). */
export function siteBrandingFromPage(platform: string, html: string, pageUrl: string, mintlifyConfig?: Record<string, unknown>): SiteBranding | undefined {
  if (platform === 'mintlify' && mintlifyConfig) {
    const stated = mintlifyBranding(mintlifyConfig);
    // what the config leaves out, the rendered page may still state (a favicon, a social handle)
    const rendered = renderedBranding(html, pageUrl);
    return stated ? { ...rendered, ...stated, seo: { ...rendered?.seo, ...stated.seo }, favicon: stated.favicon ?? rendered?.favicon, evidence: 'mintlify-config' } : rendered;
  }
  if (platform === 'gitbook') return renderedBranding(html, pageUrl, { evidence: 'gitbook-rendered', primaryVariable: '--primary-original', headerLinks: true });
  return renderedBranding(html, pageUrl);
}
