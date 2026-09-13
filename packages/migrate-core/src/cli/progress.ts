/**
 * What a long stage is doing while it does it.
 *
 * Acquiring or converting a few hundred pages prints nothing until it finishes, so an operator
 * watching a 1,500-page site cannot tell a slow stage from a stuck one, and cannot plan around it.
 *
 * Reporting is throttled rather than per page: a line for every page of a large site is noise that
 * hides the failures printed alongside it. The estimate comes from the rate so far, which is honest
 * about being an estimate — pages differ in size, and a rate that changes is visible in the line.
 */

export interface ProgressOptions {
  /** Minimum gap between lines; the first and last are always printed. */
  everyMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

function human(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}

/**
 * A reporter for one stage. Call it as each item finishes; it prints a line when enough time has
 * passed, and a final line when the count reaches the total.
 */
export function progressReporter(label: string, total: number, options: ProgressOptions = {}): (done: number) => void {
  const everyMs = options.everyMs ?? 10_000;
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now;
  const started = now();
  let lastReport = started;
  return (done: number) => {
    const at = now();
    const finished = done >= total;
    if (!finished && at - lastReport < everyMs) return;
    lastReport = at;
    const elapsed = at - started;
    if (finished) { log(`· ${label}: ${total}/${total} in ${human(elapsed)}`); return; }
    const rate = done / Math.max(elapsed, 1);
    const remaining = rate > 0 ? human((total - done) / rate) : 'unknown';
    log(`· ${label}: ${done}/${total} (${Math.floor((done / total) * 100)}%), about ${remaining} left`);
  };
}
