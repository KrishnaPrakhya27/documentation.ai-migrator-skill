/**
 * A migrated site used to open in the platform's default colours under a text logo, with none of
 * the top bar's links and every old address answering 404: the migration wrote `name`,
 * `initialRoute` and `navigation`, and nothing else the platform can be told. How a site presents
 * itself is not content, so it is a plan a person reviews (plan/site.yaml) — proposed from what
 * the source states about itself, written through the platform's own settings, checked against
 * the platform's own schema.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSiteConfig } from '@dai/content-contract';
import { hexColor, mintlifyBranding, renderedBranding, siteBrandingFromPage } from '../src/scrape/site-branding.js';
import { documentationSiteSettings, proposeSitePlan, readSitePlan, sitePlanImages, writeSitePlan, MIGRATION_STYLESHEET, MIGRATION_STYLESHEET_CSS } from '../src/nav/site-plan.js';

const DOCS_JSON = {
  name: 'Acme', description: 'Acme developer documentation.',
  colors: { primary: '#166E3F', light: '#26BD6C', dark: '#0D4A2A' },
  logo: { light: 'https://cdn.acme.test/logo/light.svg', dark: 'https://cdn.acme.test/logo/dark.svg', href: 'https://acme.test' },
  favicon: 'https://cdn.acme.test/favicon.svg',
  navbar: { links: [{ label: 'Talk to us', href: 'https://acme.test/contact' }], primary: { type: 'button', label: 'Get started', href: 'https://acme.test/start' } },
  footer: { socials: { x: 'https://x.com/acme' } },
  seo: { metatags: { 'twitter:site': '@acme', 'og:locale': 'en_US', canonical: 'https://acme.test/docs' } },
};

describe('what a source states about how it presents itself', () => {
  it('reads a Mintlify configuration: light-mode and dark-mode brand colour, logo pair, favicon, top bar, SEO statements', () => {
    expect(mintlifyBranding(DOCS_JSON)).toEqual({
      evidence: 'mintlify-config', name: 'Acme', description: 'Acme developer documentation.',
      // Mintlify draws with `primary` in light mode and with `light` in dark mode; `dark` is a hover shade
      colors: { light: '#166e3f', dark: '#26bd6c' },
      logo: { light: 'https://cdn.acme.test/logo/light.svg', dark: 'https://cdn.acme.test/logo/dark.svg', href: 'https://acme.test' },
      favicon: { light: 'https://cdn.acme.test/favicon.svg' },
      navbar: { primary: { title: 'Get started', link: 'https://acme.test/start' }, links: [{ title: 'Talk to us', link: 'https://acme.test/contact' }] },
      seo: { 'twitter:site': '@acme', 'og:locale': 'en_US' },
      unsupported: ['footer (social links and link columns): the platform has no footer setting'],
    });
  });

  it('reads a rendered page: per-scheme favicons, the header\'s logo pair, the brand colour a platform publishes as a variable, the header\'s links out', () => {
    const html = `<html><head>
      <link rel="icon" href="/~img/icon-light.png" media="(prefers-color-scheme: light)"><link rel="icon" href="/~img/icon-dark.png" media="(prefers-color-scheme: dark)">
      <link rel="apple-touch-icon" href="/touch.png"><meta property="og:site_name" content="Acme Docs"><meta name="twitter:site" content="@acme">
      <style>:root{--primary-original: 254 85 27;}</style></head><body>
      <header><a href="https://acme.test/"><img alt="Logo" class="block dark:hidden" src="/~img/logo-light.svg"><img alt="Logo" class="hidden dark:block" src="/~img/logo-dark.svg"></a>
        <a href="https://acme.test/pricing">Pricing</a><a class="button" href="https://app.acme.test/join">Sign up</a><a href="/docs/guides">Guides</a></header></body></html>`;
    expect(siteBrandingFromPage('gitbook', html, 'https://acme.test/docs')).toEqual({
      evidence: 'gitbook-rendered', name: 'Acme Docs',
      colors: { light: '#fe551b', dark: '#fe551b' },
      logo: { light: 'https://acme.test/~img/logo-light.svg', dark: 'https://acme.test/~img/logo-dark.svg' },
      favicon: { light: 'https://acme.test/~img/icon-light.png', dark: 'https://acme.test/~img/icon-dark.png' },
      // a link into the documentation is navigation, not a top-bar link; the button is the call to action
      navbar: { primary: { title: 'Sign up', link: 'https://app.acme.test/join' }, links: [{ title: 'Pricing', link: 'https://acme.test/pricing' }] },
      seo: { 'twitter:site': '@acme' },
    });
    expect(renderedBranding('<html><head></head><body><p>nothing stated</p></body></html>', 'https://x.test/')).toBeUndefined();
  });

  it('states a colour as the #rrggbb the platform accepts, or not at all', () => {
    expect(hexColor('#ABC')).toBe('#aabbcc');
    expect(hexColor('254 85 27')).toBe('#fe551b');
    expect(hexColor('rgb(22, 110, 63)')).toBe('#166e3f');
    expect(hexColor('tomato')).toBeUndefined();
  });
});

describe('the site plan', () => {
  const plan = proposeSitePlan(mintlifyBranding(DOCS_JSON));

  it('is proposed from the source\'s own statements, names what the platform has no setting for, and survives the file a person edits', () => {
    expect(plan).toMatchObject({ branding: { carry: true, colors: { light: '#166e3f', dark: '#26bd6c' } }, template: 'classic', stylesheet: true, redirects: true, notCarried: [expect.stringContaining('footer')] });
    const workspace = mkdtempSync(join(tmpdir(), 'dai-site-plan-')); mkdirSync(join(workspace, 'plan'));
    expect(readSitePlan(workspace)).toBeUndefined();
    writeSitePlan(workspace, plan);
    expect(readSitePlan(workspace)).toEqual(plan);
    writeFileSync(join(workspace, 'plan', 'site.yaml'), 'branding:\n  carry: true\n  colors:\n    light: tomato\n');
    expect(() => readSitePlan(workspace)).toThrow(/branding.colors.light "tomato" is not a colour/);
  });

  it('opens with the template a person chose at init, and classic when they chose none', () => {
    expect(proposeSitePlan(undefined, { template: 'atlas' }).template).toBe('atlas');
    expect(proposeSitePlan(undefined).template).toBe('classic');
  });

  it('asks the assets stage to host every image it shows', () => {
    expect(sitePlanImages(plan)).toEqual(['https://cdn.acme.test/logo/light.svg', 'https://cdn.acme.test/logo/dark.svg', 'https://cdn.acme.test/favicon.svg']);
    expect(sitePlanImages({ ...plan, branding: { ...plan.branding, carry: false } })).toEqual([]);
  });

  it('is written under the platform\'s own keys, with hosted images only, and the platform\'s schema accepts it', () => {
    const hosted = (url: string): string | undefined => (url.includes('/logo/') ? url.replace('cdn.acme.test', 'media.documentation.test') : undefined);
    const { settings, leftOut } = documentationSiteSettings({ name: 'Acme', plan, hosted, redirects: [{ source: '/old', destination: '/new', statusCode: 308 }, { source: '/same', destination: '/same' }, { source: '/temp', destination: '/t', statusCode: 307 }, { source: '/', destination: '/index' }] });
    expect(settings).toEqual({
      name: 'Acme', template: 'classic',
      colors: { light: { brand: '#166e3f' }, dark: { brand: '#26bd6c' } },
      'logo-light': 'https://media.documentation.test/logo/light.svg', 'logo-dark': 'https://media.documentation.test/logo/dark.svg',
      navbar: { actions: { primary: { title: 'Get started', link: 'https://acme.test/start' }, links: [{ title: 'Talk to us', link: 'https://acme.test/contact' }] } },
      seo: { 'twitter:site': '@acme', 'og:locale': 'en_US' },
      customCss: [{ src: MIGRATION_STYLESHEET }],
      redirects: [{ source: '/old', destination: '/new' }, { source: '/temp', destination: '/t', statusCode: 307 }],
    });
    // the favicon could not be hosted: it is left out and said so, never written as a link to the source host
    expect(leftOut).toEqual([expect.stringContaining('favicon: https://cdn.acme.test/favicon.svg is not hosted')]);
    expect(validateSiteConfig({ ...settings, navigation: { pages: [] } })).toEqual([]);
  });

  it('writes the name alone when a person left the source\'s brand out, and nothing at all it was not asked for', () => {
    const { settings } = documentationSiteSettings({ name: 'Acme', plan: { branding: { carry: false, colors: { light: '#166e3f' } }, stylesheet: false, redirects: false }, redirects: [{ source: '/old', destination: '/new' }] });
    expect(settings).toEqual({ name: 'Acme' });
    expect(documentationSiteSettings({ name: 'Acme' }).settings).toEqual({ name: 'Acme' });
  });

  it('ships a stylesheet that touches only what the migration itself wrote', () => {
    const selectors = [...MIGRATION_STYLESHEET_CSS.matchAll(/^([^\s/@{}][^{]*)\{/gm)].map((match) => match[1].trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector, `${selector} is not scoped to a dai-mig- hook`).toMatch(/dai-mig-/);
  });
});

describe('the platform\'s schema, as the migration applies it', () => {
  it('refuses a setting the platform does not have, where the platform itself would only ignore it', () => {
    expect(validateSiteConfig({ name: 'Acme', navigation: { pages: [] }, footer: { socials: {} } })[0].message).toMatch(/additional properties.*"footer"/);
    expect(validateSiteConfig({ name: 'Acme', navigation: { pages: [] }, colors: { light: { brand: 'green' } } })[0].message).toMatch(/\/colors\/light\/brand/);
    expect(validateSiteConfig({ name: 'Acme', navigation: { pages: [] }, template: 'fancy' })[0].message).toMatch(/\/template/);
  });
});
