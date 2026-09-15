/**
 * A deep link whose anchor the source page never had was broken before the migration ran. The
 * output reproduces the page faithfully and exact mode cannot invent the missing target, so that
 * link is reported for the customer rather than blocking the release. A link whose anchor the
 * source *did* offer and the output lost is a loss this migration caused, and still blocks.
 */
import { describe, it, expect } from 'vitest';
import { htmlAnchors, splitInheritedFragments, type FragmentProblem } from '../src/verify/fragments.js';

const problem = (target: string, fragment: string): FragmentProblem => ({ from: 'page-a', link: `/${target}#${fragment}`, reason: `${target} has no anchor "${fragment}"` });

describe('anchors the source site had already broken', () => {
  it('reads every id, name and heading slug the source page offers', () => {
    const anchors = htmlAnchors('<h1><a name="top"></a>About the profile</h1><h2 id="Member">Member activity</h2>');
    expect(anchors.has('top')).toBe(true);
    expect(anchors.has('Member')).toBe(true);
    expect(anchors.has('about-the-profile')).toBe(true);
  });

  it('treats a link the source could not resolve either as inherited, not as a loss', () => {
    const source = new Map([['target', htmlAnchors('<h2><a name="Real"></a>Real section</h2>')]]);
    const { broken, inherited } = splitInheritedFragments([problem('target', 'Profile2')], source);
    expect(inherited).toHaveLength(1);
    expect(broken).toEqual([]);
  });

  it('still blocks when the source offered the anchor and the output does not', () => {
    const source = new Map([['target', htmlAnchors('<h2><a name="Real"></a>Real section</h2>')]]);
    const { broken, inherited } = splitInheritedFragments([problem('target', 'Real')], source);
    expect(broken).toHaveLength(1);
    expect(inherited).toEqual([]);
  });

  it('excuses nothing for a route with no frozen source to compare against', () => {
    const { broken } = splitInheritedFragments([problem('target', 'Anything')], new Map());
    expect(broken).toHaveLength(1);
  });
});
