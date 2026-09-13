/**
 * Assets the block adapters never saw: srcset variants, media inside a preserved raw-HTML
 * fragment, and CSS background images. Each one left on the source platform is a file that stops
 * loading when the customer switches that platform off, so each must be inventoried, hosted and
 * rewritten. Raw HTML is preserved verbatim, so rewriting may touch nothing but the URL itself.
 */
import { describe, it, expect } from 'vitest';
import { htmlMediaReferences, rewriteHtmlMedia, srcsetUrls } from '../src/assets/html-media.js';

const hosted = (url: string): string => url.replace('https://old.example', 'https://cdn.new.example');

describe('media addressed from raw HTML', () => {
  it('reads srcset candidates in source order, ignoring the descriptors', () => {
    expect(srcsetUrls('a.png 2x, b.png 3x')).toEqual(['a.png', 'b.png']);
    expect(srcsetUrls('  a.png 480w ,  b.png 800w ')).toEqual(['a.png', 'b.png']);
    expect(srcsetUrls('only.png')).toEqual(['only.png']);
    expect(srcsetUrls('')).toEqual([]);
  });

  it('finds every media reference and names what each one is', () => {
    const html = '<figure><img src="https://old.example/a.png" srcset="https://old.example/a@2x.png 2x"/>'
      + '<video src="https://old.example/v.mp4" poster="https://old.example/p.jpg"></video>'
      + '<audio src="https://old.example/s.mp3"></audio>'
      + '<div style="background-image:url(https://old.example/bg.png); color:red">x</div></figure>';
    expect(htmlMediaReferences(html)).toEqual([
      { url: 'https://old.example/a.png', kind: 'image' },
      { url: 'https://old.example/a@2x.png', kind: 'image' },
      { url: 'https://old.example/v.mp4', kind: 'video' },
      { url: 'https://old.example/p.jpg', kind: 'poster' },
      { url: 'https://old.example/s.mp3', kind: 'audio' },
      { url: 'https://old.example/bg.png', kind: 'image' },
    ]);
  });

  it('ignores data URIs, which carry their own bytes', () => {
    expect(htmlMediaReferences('<img src="data:image/png;base64,AAAA">')).toEqual([]);
  });

  it('rewrites only the URL text, leaving the fragment otherwise byte-identical', () => {
    const html = '<div class="hero" style="background-image:url(\'https://old.example/bg.png\'); padding:4px">'
      + '<img alt="A > B" src="https://old.example/a.png" srcset="https://old.example/a@2x.png 2x, https://old.example/a@3x.png 3x" width=40>'
      + '</div>';
    const out = rewriteHtmlMedia(html, hosted);
    expect(out).toBe('<div class="hero" style="background-image:url(\'https://cdn.new.example/bg.png\'); padding:4px">'
      + '<img alt="A > B" src="https://cdn.new.example/a.png" srcset="https://cdn.new.example/a@2x.png 2x, https://cdn.new.example/a@3x.png 3x" width=40>'
      + '</div>');
  });

  it('returns the fragment unchanged when nothing moved', () => {
    const html = '<p>Nothing to rewrite <img src="/local/a.png"> here</p>';
    expect(rewriteHtmlMedia(html, (url) => url)).toBe(html);
    expect(rewriteHtmlMedia('<p>no media at all</p>', hosted)).toBe('<p>no media at all</p>');
  });

  it('rewrites an unquoted attribute value without eating the following attribute', () => {
    expect(rewriteHtmlMedia('<img src=https://old.example/a.png width=10>', hosted))
      .toBe('<img src=https://cdn.new.example/a.png width=10>');
  });
});
