import { describe, it, expect } from 'vitest';
import { defaultUrlPlan, extendUrlPlan } from '../src/urls/plan.js';
import type { Tree } from '../src/nav/tree.js';

const page = (id: string, oldPath: string, migrate = true) => ({ id, title: id, source: `https://docs.example.com${oldPath}`, oldPath, migrate, group: [] as string[], order: 0, reason: 'test' });
const tree = (pages: ReturnType<typeof page>[]): Tree => ({ scope: 'full', platform: 'gitbook', pages, navigation: [], navigationSource: 'manual' } as unknown as Tree);

describe('extendUrlPlan', () => {
  it('keeps the operator’s entries and adds the default entry for a page the tree gained', () => {
    const before = defaultUrlPlan(tree([page('a', '/docs/a')]));
    before.pages[0].new = 'guides/renamed-a';
    const after = extendUrlPlan(before, tree([page('a', '/docs/a'), page('b', '/docs/b'), page('c', '/docs/c', false)]));
    expect(after.pages.map((p) => [p.id, p.new])).toEqual([['a', 'guides/renamed-a'], ['b', 'docs/b']]);
    expect(extendUrlPlan(after, tree([page('a', '/docs/a'), page('b', '/docs/b')]))).toBe(after);
  });
  it('refuses a new page whose default route the operator already gave another page', () => {
    const before = defaultUrlPlan(tree([page('a', '/docs/a')]));
    before.pages[0].new = 'docs/b';
    expect(() => extendUrlPlan(before, tree([page('a', '/docs/a'), page('b', '/docs/b')]))).toThrow(/would take route docs\/b/);
  });
});
