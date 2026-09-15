/**
 * A wildcard redirect copies everything after the prefix into `:splat` unchanged. It can therefore
 * only stand in for exact rules that move a subtree without renaming anything inside it. Preserve
 * mode slugifies filenames as well as directories, so on a real Flare site every proposed wildcard
 * would have sent the paths it covers to files nobody wrote — while shadowing the correct rules.
 */
import { describe, it, expect } from 'vitest';
import { redirectMaps } from '../src/urls/plan.js';
import { redirectProblems } from '../src/urls/redirect-graph.js';
import type { UrlPlan } from '../src/urls/plan.js';

const plan = (pages: Array<[string, string]>): UrlPlan => ({
  mode: 'preserve', scope: 'full', preserve: { case: 'preserve' }, restructure: { strategy: 'from-nav' },
  pages: pages.map(([old, next], index) => ({ id: `p${index}`, old, new: next, reason: 'test' })),
} as unknown as UrlPlan);

describe('subtree redirect candidates', () => {
  it('proposes a wildcard when only the directory moves', () => {
    const { exact, wildcard } = redirectMaps(plan([
      ['/old/a', '/new/a'], ['/old/b', '/new/b'], ['/old/c', '/new/c'],
    ]));
    expect(exact).toHaveLength(3);
    expect(wildcard).toEqual([{ source: '/old/*', destination: '/new/:splat', statusCode: 308 }]);
  });

  it('proposes none when the filenames change too, because no splat reproduces them', () => {
    const { exact, wildcard } = redirectMaps(plan([
      ['/Procedures/Create/p_a_Step1.htm', '/procedures/create/p-a-step1'],
      ['/Procedures/Create/p_a_Step2.htm', '/procedures/create/p-a-step2'],
      ['/Procedures/Create/p_a_Step3.htm', '/procedures/create/p-a-step3'],
    ]));
    expect(exact).toHaveLength(3);
    expect(wildcard).toEqual([]);
  });

  it('leaves the rule graph clean where it once reported every exact rule as shadowed', () => {
    const { exact, wildcard } = redirectMaps(plan([
      ['/Procedures/Create/p_a_Step1.htm', '/procedures/create/p-a-step1'],
      ['/Procedures/Create/p_a_Step2.htm', '/procedures/create/p-a-step2'],
      ['/Procedures/Create/p_a_Step3.htm', '/procedures/create/p-a-step3'],
    ]));
    const routes = new Set(exact.map((rule) => rule.destination.replace(/^\//, '')));
    expect(redirectProblems([...exact, ...wildcard], routes)).toEqual([]);
  });

  it('still reports a genuine shadow, where a wildcard and an exact rule disagree', () => {
    const problems = redirectProblems([
      { source: '/old/a', destination: '/new/a', statusCode: 308 },
      { source: '/old/*', destination: '/elsewhere/:splat', statusCode: 308 },
    ], new Set(['new/a']));
    expect(problems.map((problem) => problem.kind)).toContain('shadowed');
  });
});
