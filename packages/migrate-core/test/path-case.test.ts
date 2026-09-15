/**
 * A page's address is served with the letter case its site gave it. `/Procedures/Composer` is a
 * MadCap topic's URL, and every link the customer published to it spells it that way; the plan's
 * default is to preserve the path, and "preserve" has to include its case. It did not: the legality
 * check only knew lowercase, so any segment with a capital failed it and was rewritten lowercase.
 */
import { describe, it, expect } from 'vitest';
import { legalisePath, slugifySegment } from '../src/urls/slugger.js';
import { defaultUrlPlan } from '../src/urls/plan.js';
import type { Tree } from '../src/nav/tree.js';

describe('path case', () => {
  it('keeps the case of a path that is otherwise legal', () => {
    expect(legalisePath('/Procedures/Composer/Create', { case: 'preserve' })).toEqual({ path: 'Procedures/Composer/Create', changed: false, reason: undefined });
  });

  it('still lowercases when asked to', () => {
    const lowered = legalisePath('/Procedures/Composer', { case: 'lower' });
    expect(lowered.path).toBe('procedures/composer');
    expect(lowered.reason).toContain('lowercased');
  });

  it('fixes an illegal character without touching the case around it', () => {
    expect(legalisePath('/Getting Started/Über', { case: 'preserve' }).path).toBe('Getting-Started/Uber');
    expect(slugifySegment('API Reference', { case: 'preserve' }).slug).toBe('API-Reference');
    expect(slugifySegment('API Reference').slug).toBe('api-reference');
  });

  it('is the default the URL plan applies', () => {
    const tree: Tree = { scope: 'full', platform: 'madcap', pages: [
      { id: 'p1', title: 'Create', source: 'Content/Procedures/Create.htm', group: [], order: 0, oldPath: '/Procedures/Composer/Create.htm', migrate: true, reason: 'toc' },
    ] };
    expect(defaultUrlPlan(tree).pages[0].new).toBe('Procedures/Composer/Create');
  });
});
