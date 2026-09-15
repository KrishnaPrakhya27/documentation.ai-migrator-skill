/**
 * The rendered check asks whether the image on the page is the one the migration hosted. A page
 * writes its images the way its author did — `../../Resources/Images/x.png` — while the asset
 * manifest keys them by the address they were fetched from. Looking the raw reference up found
 * nothing and compared the correctly hosted image against a relative path it could never equal,
 * which failed 323 of 428 routes on a Flare migration whose images were all hosted.
 */
import { describe, it, expect } from 'vitest';
import { hostedAssetUrl } from '../src/verify/browser.js';

const hosted = 'https://cdn.test/org-1/doc-1/abc123-Time-zone-update.gif';
const manifest = new Map([['https://learn.test/Resources/Images/Procedures/Time%20zone%20update.gif', hosted]]);
const page = 'https://learn.test/Procedures/Account%20Management/p_acount_PlatformTimeZone.htm';

describe('finding where an image the page authored now lives', () => {
  it('resolves a page-relative reference against the page it appears on', () => {
    expect(hostedAssetUrl('../../Resources/Images/Procedures/Time zone update.gif', page, manifest)).toBe(hosted);
  });

  it('resolves a root-relative reference too', () => {
    expect(hostedAssetUrl('/Resources/Images/Procedures/Time zone update.gif', page, manifest)).toBe(hosted);
  });

  it('accepts a reference already escaped the way the manifest spells it', () => {
    expect(hostedAssetUrl('../../Resources/Images/Procedures/Time%20zone%20update.gif', page, manifest)).toBe(hosted);
  });

  it('still takes an exact key without needing the page', () => {
    expect(hostedAssetUrl('https://learn.test/Resources/Images/Procedures/Time%20zone%20update.gif', undefined, manifest)).toBe(hosted);
  });

  it('finds nothing for an image the migration never hosted', () => {
    expect(hostedAssetUrl('../../Resources/Images/Procedures/absent.png', page, manifest)).toBeUndefined();
  });
});
