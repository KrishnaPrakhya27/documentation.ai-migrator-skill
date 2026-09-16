/**
 * Two kinds of link the migration cannot make land, told apart. A link to an anchor or a route the
 * source never had was broken before the migration — the source site 404s on it too — and is the
 * customer's to fix, so it is listed for them and does not block. A link to something the source
 * offered and the output lacks is this migration's, and does.
 *
 * GitBook is the hard case: it publishes no ids, and links its headings under its own slugger —
 * "3. Payment terms" as `#id-3.-payment-terms`, "Edit on GitHub/GitLab" as `#edit-on-github-gitlab`,
 * sometimes without the dots. Those ids are recorded and shimmed where a link still uses them.
 */
import { describe, it, expect } from 'vitest';
import { gitbookHeadingId, gitbookHeadingIds } from '../src/urls/slugger.js';
import { anchorMap } from '../src/urls/plan.js';
import { headingOutline, normaliseMdxText, proseSegments } from '../src/verify/gates.js';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';

describe('GitBook heading ids', () => {
  it('follow GitBook\'s own rule, digits prefixed and dots kept', () => {
    expect(gitbookHeadingId('3. Payment terms')).toBe('id-3.-payment-terms');
    expect(gitbookHeadingId('Edit on GitHub/GitLab')).toBe('edit-on-github-gitlab');
    expect(gitbookHeadingIds('A. How Does This Actually Work?').slice(0, 2)).toEqual(['a.-how-does-this-actually-work', 'a-how-does-this-actually-work']);
    // the spellings GitBook has used at different times are all offered, the current rule first
    expect(gitbookHeadingIds('Math & TeX')[0]).toBe('math-and-tex');
    expect(gitbookHeadingIds('3. Payment Terms.')[0]).toBe('id-3.-payment-terms');
    expect(gitbookHeadingIds('1. Create an app registration in Azure AD')).toContain('id-1.-create-an-app-registration-in-azure-a-d');
    expect(gitbookHeadingIds("GitBook's global privacy practices")).toContain('gitbooks-global-privacy-practices');
  });

  it('shim a heading under whichever spelling a link used, and a component under the anchor the source gave it', () => {
    const pages = [{ pageId: 'p', headings: [
      { id: 'h1', text: 'A. How Does This Actually Work?', sourceId: 'a.-how-does-this-actually-work', aliases: ['a-how-does-this-actually-work'] },
      { id: 'c1', text: '', sourceId: 'param-icons', component: true },
      { id: 'h2', text: 'Untouched', sourceId: 'untouched' },
    ] }];
    // the dotless spelling is the renderer's own id, so a link to it needs nothing; the dotted one does
    expect(anchorMap(pages, new Map([['#a-how-does-this-actually-work', 1]])).shims.get('p')?.has('h1') ?? false).toBe(false);
    const { shims } = anchorMap(pages, new Map([['#a.-how-does-this-actually-work', 1], ['#param-icons', 3]]));
    expect(shims.get('p')?.get('h1')).toBe('a.-how-does-this-actually-work');
    expect(shims.get('p')?.get('c1')).toBe('param-icons');
    expect(shims.get('p')?.has('h2')).toBe(false);
  });

  it('writes the component shim into the page, where the fragment gate can see it', () => {
    const doc = { pageId: 'p', platform: 'mintlify', source: 'x', frontmatter: { title: 'T' }, children: [
      { id: 'c1', type: 'dai' as const, name: 'ResponseField', props: { name: 'icons', 'field-type': 'object' }, children: [] },
    ] };
    expect(docToMdx(doc as any, { anchorShims: new Map([['c1', 'param-icons']]) })).toContain('<a id="param-icons"></a>\n\n<ResponseField');
  });
});

describe('what GitBook shows as text', () => {
  const read = (body: string) => markdownToIr(`---\ntitle: T\n---\n\n${body}\n`, { platform: 'gitbook', file: 'p.md', pageId: 'p' });

  it('keeps an angle-bracketed word GitBook does not render as an element', () => {
    const doc = read('### gitbook integrations new <dir>\n\nCreates <num> files, then <dir> holds them.');
    // the outline normalises `>` away on both sides; what matters is that `<dir` is still in the heading
    expect(headingOutline(doc)).toEqual(['3:gitbook integrations new <dir']);
    expect(JSON.stringify(doc.children)).toContain('Creates <num> files, then <dir> holds them.');
  });

  it('still reads the HTML GitBook does write', () => {
    const doc = read('Press <kbd>Ctrl</kbd> and see <sup>1</sup>.');
    const text = JSON.stringify(doc.children);
    expect(text).toContain('"type":"kbd"');
    expect(text).toContain('<sup>1</sup>');
    expect(text).not.toContain('&lt;kbd');
  });
});

describe('the prose normaliser', () => {
  it('reads a code span as text on both sides, so `<MDX>` compares with itself', () => {
    const doc = markdownToIr('---\ntitle: T\n---\n\n* **Améliorations de `<MDX>` :** les titres.\n', { platform: 'mintlify', file: 'c.md', pageId: 'c' });
    const [segment] = proseSegments(doc);
    expect(normaliseMdxText('* **Améliorations de `<MDX>` :** les titres.')).toContain(segment);
  });

  it('counts a raw <h1> element as the heading it renders', () => {
    const doc = { pageId: 'p', platform: 'mintlify', source: 'x', frontmatter: { title: 'Introduction' }, children: [
      { id: 'a', type: 'component' as const, name: 'h1', platform: 'mintlify', props: {}, children: [{ id: 'b', type: 'paragraph' as const, children: [{ id: 'c', type: 'text' as const, value: 'Documentation' }] }] },
      { id: 'd', type: 'heading' as const, depth: 2 as const, children: [{ id: 'e', type: 'text' as const, value: 'Related topics' }] },
    ] };
    expect(headingOutline(doc as any)).toEqual(['1:documentation', '2:related topics']);
  });
});
