/**
 * Sanitise raw HTML into a JSX fragment the deployment contract accepts.
 * Removes anything executable or cross-page, then JSX-ifies attributes.
 * Used for T7 preserve and for HTML-in-Markdown sources.
 */
import { parseHtml, type Dom, type El } from '../ir/from-html.js';

const DROP_TAGS = new Set(['script', 'style', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'noscript', 'template', 'svg', 'canvas', 'applet', 'frame', 'frameset']);
const VOID = new Set(['br', 'hr', 'img', 'wbr', 'source', 'col', 'area']);
const ATTR_RENAME: Record<string, string> = { class: 'className', for: 'htmlFor', tabindex: 'tabIndex', colspan: 'colSpan', rowspan: 'rowSpan', readonly: 'readOnly', maxlength: 'maxLength', srcset: 'srcSet', autoplay: 'autoPlay', allowfullscreen: 'allowFullScreen', frameborder: 'frameBorder' };
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'xlink:href']);

export interface SanitizeOptions { iframeHosts?: string[] }

export function isSafeUrl(u: string, kind: 'link' | 'resource' = 'link'): boolean {
  const t = u.trim().replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  const scheme = t.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  const allowed = kind === 'link' ? ['http', 'https', 'mailto', 'tel'] : ['http', 'https'];
  if (scheme && !allowed.includes(scheme)) return false;
  return true;
}

function styleToJsx(style: string): string {
  const obj: string[] = [];
  for (const decl of style.split(';')) {
    const [k, ...rest] = decl.split(':');
    if (!k || !rest.length) continue;
    const key = k.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (!key || !val) continue;
    if (/position\s*:?/.test(key) && /fixed|sticky/.test(val)) continue; // cross-page positioning
    if (key === 'z-index' && Number(val) > 10) continue;
    if (/url\(/.test(val) && !/url\(\s*["']?\/?[^:)]*\)/.test(val)) continue; // external url()
    if (/expression\(|javascript:/i.test(val)) continue;
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    obj.push(`${camel}: ${JSON.stringify(val)}`);
  }
  return obj.length ? `{{ ${obj.join(', ')} }}` : '';
}

function ser(n: Dom, opts: SanitizeOptions): string {
  if (n.type === 'text') return n.data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
  const name = n.name;
  if (name === '#root') return n.children.map((c) => ser(c, opts)).join('');
  if (DROP_TAGS.has(name)) return '';
  if (name === 'iframe') {
    const src = n.attribs.src ?? '';
    let host = '';
    try { host = new URL(src).hostname; } catch { return ''; }
    const allowed = (opts.iframeHosts ?? ['www.youtube.com', 'youtube.com', 'player.vimeo.com', 'www.loom.com']).some((h) => host === h || host.endsWith('.' + h));
    if (!allowed) return '';
  }
  const IFRAME_ATTRS = new Set(['src', 'title', 'width', 'height', 'loading', 'allowfullscreen']);
  if (name === 'iframe') for (const k of Object.keys(n.attribs)) if (!IFRAME_ATTRS.has(k.toLowerCase())) delete n.attribs[k]; // srcdoc, sandbox, allow, csp, referrerpolicy never survive
  const attrs: string[] = [];
  for (const [k0, v] of Object.entries(n.attribs)) {
    const k = k0.toLowerCase();
    if (k.startsWith('on')) continue;
    if (URL_ATTRS.has(k) && !isSafeUrl(v, k === 'href' ? 'link' : 'resource')) continue;
    // Inline React style objects are MDX expressions. The v1 contract forbids
    // arbitrary expressions, so T7 preservation drops style and keeps content.
    if (k === 'style') continue;
    if (k === 'id' && !/^[A-Za-z][\w:.-]*$/.test(v)) continue;
    const key = ATTR_RENAME[k] ?? (k.includes('-') ? k : k);
    if (!/^[A-Za-z_][\w:-]*$/.test(key)) continue;
    attrs.push(v === '' ? key : `${key}="${v.replace(/"/g, '&quot;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')}"`);
  }
  const a = attrs.length ? ' ' + attrs.join(' ') : '';
  if (VOID.has(name)) return `<${name}${a} />`;
  return `<${name}${a}>${n.children.map((c) => ser(c, opts)).join('')}</${name}>`;
}

export function sanitizeHtmlToJsx(html: string, opts: SanitizeOptions = {}): string {
  const root = parseHtml(html.replace(/<!--[\s\S]*?-->/g, ''));
  return ser(root, opts).trim();
}

/** Generated CSS policy: namespace selectors, reject cross-page and tracking constructs. */
export function checkCss(css: string, container = '.dai-doc'): { ok: boolean; css: string; violations: string[] } {
  const violations: string[] = [];
  if (/@import/i.test(css)) violations.push('@import is not allowed');
  if (/url\(\s*["']?https?:/i.test(css)) violations.push('external url() is not allowed');
  if (/position\s*:\s*(fixed|sticky)/i.test(css)) violations.push('fixed/sticky positioning is not allowed');
  if (/z-index\s*:\s*(\d{2,})/i.test(css)) violations.push('z-index above 9 is not allowed');
  if (/expression\(|behavior\s*:|-moz-binding/i.test(css)) violations.push('script-like CSS is not allowed');
  const namespaced = css.replace(/(^|\})\s*([^{}@]+)\{/g, (m, pre, sel) => {
    const sels = sel.split(',').map((s: string) => s.trim()).filter(Boolean).map((s: string) => (s.startsWith(container) ? s : `${container} ${s}`));
    return `${pre}\n${sels.join(', ')} {`;
  });
  return { ok: violations.length === 0, css: namespaced.trim(), violations };
}
