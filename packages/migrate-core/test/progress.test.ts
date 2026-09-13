/**
 * A stage that prints nothing for twenty minutes cannot be told apart from a stuck one. A line per
 * page of a 1,500-page site is the opposite problem: it buries the failures printed beside it.
 */
import { describe, it, expect } from 'vitest';
import { progressReporter } from '../src/cli/progress.js';

const harness = () => {
  const lines: string[] = [];
  let clock = 0;
  return { lines, tick: (ms: number) => { clock += ms; }, options: { log: (line: string) => lines.push(line), now: () => clock, everyMs: 10_000 } };
};

describe('reporting a long stage', () => {
  it('reports on its interval rather than per item, and estimates from the rate so far', () => {
    const { lines, tick, options } = harness();
    const report = progressReporter('acquired', 100, options);
    for (let done = 1; done <= 50; done++) { tick(200); report(done); }
    // 50 items at 200ms each: one line at ten seconds, not fifty lines
    expect(lines).toEqual(['· acquired: 50/100 (50%), about 10s left']);
  });

  it('always prints the finish, with what it took', () => {
    const { lines, tick, options } = harness();
    const report = progressReporter('converted', 3, options);
    tick(1000); report(1);
    tick(1000); report(2);
    tick(1000); report(3);
    expect(lines).toEqual(['· converted: 3/3 in 3s']);
  });

  it('writes minutes for a long stage rather than a large number of seconds', () => {
    const { lines, tick, options } = harness();
    const report = progressReporter('acquired', 1000, options);
    tick(60_000); report(100);
    expect(lines[0]).toBe('· acquired: 100/1000 (10%), about 9m left');
  });

  it('says the remaining time is unknown rather than guessing before anything finished', () => {
    const { lines, tick, options } = harness();
    const report = progressReporter('acquired', 10, options);
    tick(11_000); report(0);
    expect(lines[0]).toContain('about unknown left');
  });
});
