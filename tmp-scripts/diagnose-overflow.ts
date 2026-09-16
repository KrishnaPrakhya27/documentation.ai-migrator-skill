import { openChromeSession } from '../packages/migrate-core/src/verify/chrome-session.js';

const preview = 'https://migration-mig-5d53b491fe--demo-session.documentationai.com';
const routes = process.argv.slice(2);
const EXPR = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect();
    if (b.width <= vw + 4 && b.right <= vw + 4) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    let scrollableParent = false;
    for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') { scrollableParent = true; break; } }
    if (scrollableParent) continue;
    const chain = [];
    for (let p = el; p && chain.length < 5; p = p.parentElement) chain.push(p.tagName.toLowerCase() + (typeof p.className === 'string' && p.className ? '.' + p.className.trim().split(/\\s+/).slice(0,2).join('.') : ''));
    out.push({ tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className.slice(0, 90) : '', w: Math.round(b.width), right: Math.round(b.right), pos: cs.position, display: cs.display, maxW: cs.maxWidth, chain: chain.join(' < ') });
  }
  return JSON.stringify({ vw, scrollWidth: document.documentElement.scrollWidth, widest: out.sort((a, b) => b.w - a.w).slice(0, 6) }, null, 1);
})()`;

const session = await openChromeSession(preview);
try {
  for (const route of routes) {
    const result = await session.measure<string>(`${preview}/${route}`, EXPR, { viewport: { width: 390, height: 844 } });
    console.log(`\n===== ${route} =====\n${result}`);
  }
} finally { await session.close(); }
