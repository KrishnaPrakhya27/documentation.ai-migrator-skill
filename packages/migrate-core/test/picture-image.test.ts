/**
 * GitBook wraps a responsive image in `<picture><source srcset="…"/><img …/></picture>`. The
 * image is the content; the wrapper and its sources are the theme's art direction. Read as
 * unknown inline components they left two markers on every image — 896 on one 300-page site.
 */
import { describe, it, expect } from 'vitest';
import { markdownToIr } from '../src/ir/from-markdown.js';

const PICTURE = '<picture><source srcset="https://cdn.example/a.avif 1x, https://cdn.example/a@2x.avif 2x" type="image/avif" /><img src="https://cdn.example/a.png" alt="A diagram" /></picture>';
const read = (body: string) => markdownToIr(`---\ntitle: T\n---\n\n${body}\n`, { platform: 'gitbook', file: 'p.md', pageId: 'p' });

describe('a picture wrapper', () => {
  it('is the image it holds, with its sources, and leaves no marker', () => {
    const doc = read(`Intro ${PICTURE} outro.`);
    const text = JSON.stringify(doc.children);
    expect(text).not.toContain('UNSUPPORTED');
    expect(text).toContain('"url":"https://cdn.example/a.png"');
    expect(text).toContain('a@2x.avif');
    expect(text).toContain('"alt":"A diagram"');
  });

  it('is an image block when it stands alone', () => {
    const doc = read(PICTURE);
    expect(doc.children.map((block) => block.type)).toEqual(['image']);
  });
});
