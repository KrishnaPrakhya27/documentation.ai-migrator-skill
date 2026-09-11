/**
 * A migrated site shows Documentation.AI's branding, never the source's. The
 * renderer falls back to its own logo and favicon whenever documentation.json
 * omits them, so the migration's only job is to never write them.
 */
import { describe, it, expect } from 'vitest';
import { SOURCE_BRANDING_KEYS, documentationSiteSettings, withoutSourceBranding } from '../src/nav/site-settings.js';

describe('documentation.json site settings', () => {
  it('carries the documentation name and none of the source branding', () => {
    const sourceMeta = {
      platform: 'mintlify',
      name: 'Acme Docs',
      theme: 'willow',
      colors: { primary: '#112233', light: '#445566', dark: '#778899' },
      logo: { light: 'https://cdn.acme.example/light.svg', dark: 'https://cdn.acme.example/dark.svg' },
      favicon: 'https://cdn.acme.example/favicon.svg',
    };
    expect(documentationSiteSettings(sourceMeta)).toEqual({ name: 'Acme Docs' });
  });

  it('writes nothing when the source states no name', () => {
    expect(documentationSiteSettings({})).toEqual({});
    expect(documentationSiteSettings({ name: '' })).toEqual({});
    expect(documentationSiteSettings({ name: 42 })).toEqual({});
  });

  it('strips branding an earlier run wrote, and keeps everything else', () => {
    const earlierRun = {
      name: 'Acme Docs',
      initialRoute: 'index',
      navigation: { groups: [] },
      favicon: 'https://cdn.acme.example/favicon.svg',
      logo: { light: 'https://cdn.acme.example/light.svg' },
      'logo-dark': 'https://cdn.acme.example/dark.svg',
      'logo-light': 'https://cdn.acme.example/light.svg',
      'logo-small-dark': 'https://cdn.acme.example/small-dark.svg',
      'logo-small-light': 'https://cdn.acme.example/small-light.svg',
      colors: { primary: '#112233' },
      theme: 'willow',
    };
    expect(withoutSourceBranding(earlierRun)).toEqual({ name: 'Acme Docs', initialRoute: 'index', navigation: { groups: [] } });
  });

  it('names every branding key of the Documentation.AI config', () => {
    // documentation-ai-app/src/types/documentations.ts: logo, logo-dark, logo-light, logo-small-dark, logo-small-light, favicon, colors, theme
    expect([...SOURCE_BRANDING_KEYS].sort()).toEqual(['colors', 'favicon', 'logo', 'logo-dark', 'logo-light', 'logo-small-dark', 'logo-small-light', 'theme']);
  });
});
