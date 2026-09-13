/**
 * One run at a time in a workspace.
 *
 * Every stage reads `session.json`, does its work and writes it back. Two runs in one workspace
 * therefore overwrite each other's pins: the second finishes, the first writes a stale session over
 * it, and the workspace now claims hashes that describe neither run. Nothing prevented that — an
 * operator running two stages in two terminals, or a retried job, was enough.
 *
 * The lock is a file created exclusively, holding the process that owns it. A lock whose process is
 * gone is stale — a crashed run leaves one behind — and is taken over with that fact recorded,
 * because refusing forever would mean a crash makes a workspace unusable.
 */
import { openSync, closeSync, writeSync, readFileSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface LockHolder {
  pid: number;
  command: string;
  at: string;
  /** PID reuse and stale-lock takeover cannot make another process look like this owner. */
  token?: string;
}

/** A sibling lock exists before the workspace does, so two init commands cannot create it together. */
export const lockPath = (workspace: string): string => join(dirname(workspace), `.${basename(workspace)}.lock`);

function holderOf(path: string): LockHolder | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as LockHolder; } catch { return undefined; }
}

/** Whether the process holding a lock is still running; an unreadable lock is treated as stale. */
function alive(holder: LockHolder | undefined): boolean {
  if (!holder || typeof holder.pid !== 'number') return false;
  try { process.kill(holder.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface WorkspaceLock {
  /** What was found and taken over, when a crashed run had left its lock behind. */
  tookOver?: LockHolder;
  release: () => void;
}

/**
 * Claims the workspace for this process. Throws when another live run holds it, naming that run so
 * the operator can tell a real conflict from a crash.
 */
export function acquireWorkspaceLock(workspace: string, command: string): WorkspaceLock {
  const path = lockPath(workspace);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const holder: LockHolder = { pid: process.pid, command, at: new Date().toISOString(), token: randomUUID() };
  const claim = (): number | undefined => {
    try { return openSync(path, 'wx', 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return undefined;
    }
  };
  let descriptor = claim();
  let tookOver: LockHolder | undefined;
  if (descriptor === undefined) {
    const existing = holderOf(path);
    if (alive(existing)) {
      throw new Error(`workspace is in use by pid ${existing!.pid} running "${existing!.command}" since ${existing!.at}; wait for it to finish, or remove ${path} if that process is gone`);
    }
    // Move exactly the stale inode we inspected. Unlinking by name lets two contenders both inspect
    // the stale owner and lets the slower one delete the faster one's newly claimed lock.
    const stale = `${path}.stale-${holder.token}`;
    try { renameSync(path, stale); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`workspace lock at ${path} changed while it was being taken over; retry the command`);
      throw error;
    }
    descriptor = claim();
    rmSync(stale, { force: true });
    if (descriptor === undefined) throw new Error(`workspace lock at ${path} could not be claimed; another run took it first`);
    tookOver = existing;
  }
  writeSync(descriptor, JSON.stringify(holder, null, 2) + '\n');
  closeSync(descriptor);
  let released = false;
  return {
    ...(tookOver ? { tookOver } : {}),
    release: () => {
      if (released) return;
      released = true;
      // Only ever release a lock this process still owns: a takeover elsewhere must not be undone.
      if (existsSync(path) && holderOf(path)?.token === holder.token) rmSync(path, { force: true });
    },
  };
}
