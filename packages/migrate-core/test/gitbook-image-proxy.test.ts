import { describe, it, expect } from 'vitest';
import { gitbookImageProxyTarget, resolveAssetUrl } from '../src/assets/manifest.js';

const INNER = 'https://1050631731-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FNk%2Fuploads%2F89%2Factions.svg?alt=media&token=2b5d001e';
const PROXY = `https://sites.gitbook.com/preview/site_p4Xo4/~gitbook/image?url=${encodeURIComponent(INNER)}&width=300&dpr=3&quality=100&sign=d841db7e&sv=2`;

describe('GitBook image proxy', () => {
  it('reads the file the proxy points at, not the proxy', () => {
    expect(gitbookImageProxyTarget(PROXY)).toBe(INNER);
    expect(resolveAssetUrl(PROXY, 'https://gitbook.com/docs/collaborate/member-management')).toBe(INNER);
  });

  it('leaves every other URL alone', () => {
    expect(gitbookImageProxyTarget(INNER)).toBeUndefined();
    expect(gitbookImageProxyTarget('https://example.com/a.png')).toBeUndefined();
    // a path that merely contains the words is not the proxy endpoint
    expect(gitbookImageProxyTarget('https://h/~gitbook/image/extra?url=https://x/y.png')).toBeUndefined();
    // the proxy without a usable target stays as it is, rather than becoming undefined content
    expect(gitbookImageProxyTarget('https://h/~gitbook/image?width=300')).toBeUndefined();
    expect(gitbookImageProxyTarget('https://h/~gitbook/image?url=/relative.png')).toBeUndefined();
  });

  it('still resolves a relative URL against the page', () => {
    expect(resolveAssetUrl('img/a.png', 'https://gitbook.com/docs/x')).toBe('https://gitbook.com/docs/img/a.png');
  });
});
