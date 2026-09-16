/**
 * Redirects fail as a set, not as rules. Each rule here is well-formed on its own; together they
 * loop, chain, claim one old path twice, or land where no page was written — and a reader finds out
 * by clicking an old link on the day the domain moves.
 */
import { describe, it, expect } from 'vitest';
import { redirectProblems } from '../src/urls/redirect-graph.js';
import type { RedirectRule } from '../src/urls/plan.js';

const rule = (source: string, destination: string): RedirectRule => ({ source, destination, statusCode: 308 });
const kinds = (problems: ReturnType<typeof redirectProblems>): string[] => problems.map((problem) => problem.kind).sort();

describe('redirects read as a graph', () => {
  it('passes a set that simply moves paths', () => {
    expect(redirectProblems([rule('/old-guide', '/guides/install'), rule('/legacy', '/index')], new Set(['guides/install', 'index']))).toEqual([]);
  });

  it('reports two rules claiming the same old path', () => {
    const problems = redirectProblems([rule('/a', '/b'), rule('/a', '/c')], new Set(['b', 'c']));
    expect(kinds(problems)).toContain('conflict');
    expect(problems[0].detail).toContain('/a is redirected to');
  });

  it('reports a redirect whose destination is itself redirected', () => {
    const problems = redirectProblems([rule('/a', '/b'), rule('/b', '/c')], new Set(['c']));
    expect(kinds(problems)).toContain('chain');
    expect(problems.find((problem) => problem.kind === 'chain')?.detail).toContain('/a → /b → /c');
  });

  it('reports a cycle rather than following it forever', () => {
    const problems = redirectProblems([rule('/a', '/b'), rule('/b', '/a')], new Set());
    expect(kinds(problems)).toContain('loop');
  });

  it('reports two old paths that differ only by case', () => {
    const problems = redirectProblems([rule('/Guides/Install', '/guides/install'), rule('/guides/install', '/guides/setup')], new Set(['guides/install', 'guides/setup']));
    expect(kinds(problems)).toContain('case-collision');
  });

  it('reports a destination no written page answers, and accepts an index page', () => {
    expect(kinds(redirectProblems([rule('/old', '/gone')], new Set(['guides/install'])))).toContain('missing-target');
    expect(redirectProblems([rule('/old', '/guides')], new Set(['guides/index']))).toEqual([]);
    // a destination that leaves the site is somebody else's to answer
    expect(redirectProblems([rule('/old', 'https://status.example.com')], new Set(['a']))).toEqual([]);
  });

  it('reports a wildcard that covers an exact rule, where the host decides which one runs', () => {
    // the exact rule sends the path somewhere the wildcard would not, so the host's order decides
    const problems = redirectProblems([rule('/docs/*', '/guides/:splat'), rule('/docs/install', '/setup/install')], new Set(['guides/install', 'setup/install']));
    expect(kinds(problems)).toContain('shadowed');
    // a wildcard that agrees with every exact rule beneath it is the same rule said once
    expect(kinds(redirectProblems([rule('/docs/*', '/guides/:splat'), rule('/docs/install', '/guides/install')], new Set(['guides/install'])))).not.toContain('shadowed');
  });

  it('reports a rule whose old path carries a query or fragment, which never matches', () => {
    expect(kinds(redirectProblems([rule('/old?page=2', '/new')], new Set(['new'])))).toContain('lost-query');
  });
});
