/**
 * Redirects read as a graph, not as a list of rules.
 *
 * Each rule can be individually well-formed while the set of them is broken: two rules claiming the
 * same old path, a rule pointing at a path that is itself redirected, a cycle, or a rule whose
 * destination no page was written for. Every one of those is invisible to a per-rule check and
 * obvious to a reader who clicks the old link — they arrive at a loop, an extra hop, or a 404 on
 * the day the domain moves, which is the moment the customer's search traffic is most exposed.
 *
 * Nothing here rewrites the rules. The redirects belong to the customer's URLs, so a problem is
 * reported for a person to resolve rather than silently "fixed" into a different set.
 */
import type { RedirectRule } from './plan.js';

export type RedirectProblemKind = 'conflict' | 'loop' | 'chain' | 'case-collision' | 'missing-target' | 'shadowed' | 'lost-query';

export interface RedirectProblem {
  kind: RedirectProblemKind;
  detail: string;
}

const normalise = (path: string): string => `/${path.replace(/^\/+|\/+$/g, '')}`;
const isWildcard = (source: string): boolean => /[*]|:splat/.test(source);
/** A destination that leaves the site is somebody else's to resolve. */
const isExternal = (destination: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination) || destination.startsWith('//');

/**
 * Every way this set of rules fails a reader, in the order an operator should fix them.
 *
 * `routes` holds what the migration wrote, without extensions and without a leading slash, so a
 * destination can be checked against a page that exists.
 */
export function redirectProblems(rules: readonly RedirectRule[], routes: ReadonlySet<string> = new Set()): RedirectProblem[] {
  const problems: RedirectProblem[] = [];
  const exact = rules.filter((rule) => !isWildcard(rule.source));
  const wildcards = rules.filter((rule) => isWildcard(rule.source));

  // Two rules for one old path: which one runs is the platform's choice, not the customer's.
  const bySource = new Map<string, Set<string>>();
  for (const rule of exact) {
    const source = normalise(rule.source);
    // A destination that leaves the site keeps its own address: normalising it as a path would turn
    // "https://status.example.com" into a route this migration was supposed to have written.
    const destination = isExternal(rule.destination) ? rule.destination : normalise(rule.destination);
    bySource.set(source, (bySource.get(source) ?? new Set()).add(destination));
  }
  for (const [source, destinations] of bySource) {
    if (destinations.size > 1) problems.push({ kind: 'conflict', detail: `${source} is redirected to ${[...destinations].sort().join(' and ')}` });
  }

  // Paths that differ only by case: most hosts match a redirect case-insensitively, so one of the
  // two rules is unreachable and which one depends on the host.
  const byLowercase = new Map<string, Set<string>>();
  for (const source of bySource.keys()) {
    const key = source.toLowerCase();
    byLowercase.set(key, (byLowercase.get(key) ?? new Set()).add(source));
  }
  for (const [, sources] of byLowercase) {
    if (sources.size > 1) problems.push({ kind: 'case-collision', detail: `${[...sources].sort().join(' and ')} differ only by case, and a host that matches case-insensitively will run only one of them` });
  }

  // A query or fragment in a rule's source is not matched by the platforms that run these rules,
  // so the rule silently never fires.
  for (const rule of rules) {
    if (/[?#]/.test(rule.source)) problems.push({ kind: 'lost-query', detail: `${rule.source} carries a query or fragment, which a redirect rule does not match` });
  }

  const destinationOf = new Map([...bySource].map(([source, destinations]) => [source, [...destinations][0]]));

  // A destination that is itself redirected: readers pay two hops, and some hosts refuse to chain.
  for (const [source, destination] of destinationOf) {
    if (isExternal(destination)) continue;
    const next = destinationOf.get(destination);
    if (next && next !== destination) problems.push({ kind: 'chain', detail: `${source} → ${destination} → ${next}: redirect to the final path instead` });
  }

  // A cycle never resolves; the reader gets an error from the host rather than a page.
  for (const start of destinationOf.keys()) {
    const seen = new Set<string>([start]);
    let current = destinationOf.get(start);
    while (current && !isExternal(current)) {
      if (seen.has(current)) { problems.push({ kind: 'loop', detail: `${[...seen].join(' → ')} → ${current} is a redirect loop` }); break; }
      seen.add(current);
      current = destinationOf.get(current);
    }
  }

  // A rule that lands nowhere is a 404 with extra steps.
  if (routes.size) {
    const known = new Set([...routes].map((route) => normalise(route)));
    for (const [source, destination] of destinationOf) {
      if (isExternal(destination) || isWildcard(destination) || destinationOf.has(destination)) continue;
      if (!known.has(destination) && !known.has(normalise(`${destination}/index`))) {
        problems.push({ kind: 'missing-target', detail: `${source} → ${destination}, which no written page answers` });
      }
    }
  }

  // A wildcard covering an exact rule's path: whichever the host prefers, one of them is dead.
  // …unless both send the path to the same place, in which case the host's ordering changes
  // nothing: the wildcard is the same rule said once for the whole subtree.
  for (const wildcard of wildcards) {
    const prefix = normalise(wildcard.source.replace(/[*].*$/, '').replace(/:splat.*$/, ''));
    const destinationPrefix = wildcard.destination.replace(/:splat.*$/, '').replace(/[*].*$/, '');
    for (const [source, destinations] of bySource) {
      if (source === prefix || !source.startsWith(prefix === '/' ? '/' : `${prefix}/`)) continue;
      const rest = source.slice(prefix === '/' ? 1 : prefix.length + 1);
      if ([...destinations].every((destination) => normalise(`${destinationPrefix}${rest}`) === normalise(destination))) continue;
      problems.push({ kind: 'shadowed', detail: `${wildcard.source} covers ${source}, and which rule runs depends on the host's ordering` });
    }
  }

  return problems;
}
