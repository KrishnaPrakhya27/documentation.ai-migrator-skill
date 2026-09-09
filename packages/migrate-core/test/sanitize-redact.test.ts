import { describe, it, expect } from 'vitest';
import { sanitizeHtmlToJsx, checkCss } from '../src/components/sanitize.js';
import { redact, looksSecret } from '../src/log/redact.js';
import { pageIdFromPlatform, uuidv5, PAGE_NAMESPACE } from '../src/session/ids.js';

describe('sanitizeHtmlToJsx', () => {
  it('strips executable and cross-page constructs and JSX-ifies attributes', () => {
    const html = `<div class="x" onclick="a()" style="color:red;position:fixed;z-index:999"><script>1</script><a href="javascript:alert(1)">j</a><img src="/a.png" alt="A"><iframe src="https://evil.example/x"></iframe><iframe src="https://www.youtube.com/embed/1"></iframe><span for="q">t</span></div>`;
    const out = sanitizeHtmlToJsx(html);
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('className="x"');
    expect(out).toContain('htmlFor="q"');
    expect(out).toContain('<img src="/a.png" alt="A" />');
    expect(out).toContain('youtube.com/embed/1');
    expect(out).not.toContain('style=');
  });
  it('rejects obfuscated executable URL schemes', () => {
    const out = sanitizeHtmlToJsx('<a href="java&#x09;script:alert(1)">x</a><a href="https://safe.example/x">ok</a>');
    expect(out).not.toContain('javascript');
    expect(out).toContain('https://safe.example/x');
  });
});

describe('checkCss', () => {
  it('namespaces selectors and rejects imports, external urls and fixed positioning', () => {
    const r = checkCss(`@import url(x.css); .badge { position: fixed; background: url(https://t.example/p.png) } .ok { color: red }`);
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBe(3);
    const ok = checkCss(`.dai-mig-badge { color: red } .b, .c { margin: 0 }`);
    expect(ok.ok).toBe(true);
    expect(ok.css).toContain('.dai-doc .dai-mig-badge');
    expect(ok.css).toContain('.dai-doc .b, .dai-doc .c');
  });
});

describe('redact', () => {
  it('masks bearer tokens, api keys, jwts and signed urls', () => {
    const s = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456 api_key=sk_live_1234567890abcdefghij eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c https://b.example/o?X-Amz-Signature=abc';
    const r = redact(s);
    expect(r).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(r).not.toContain('sk_live_');
    expect(r).not.toContain('eyJhbGciOi.');
    expect(r).toContain('<redacted-signed-url>');
    expect(looksSecret(s)).toBe(true);
    expect(looksSecret('plain prose about migration')).toBe(false);
  });
});

describe('identity', () => {
  it('derives stable page ids from platform ids, never from content', () => {
    expect(pageIdFromPlatform('document360', '5f1c2a')).toBe(pageIdFromPlatform('document360', '5f1c2a'));
    expect(pageIdFromPlatform('document360', '5f1c2a')).not.toBe(pageIdFromPlatform('readme', '5f1c2a'));
    expect(uuidv5(PAGE_NAMESPACE, 'x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
