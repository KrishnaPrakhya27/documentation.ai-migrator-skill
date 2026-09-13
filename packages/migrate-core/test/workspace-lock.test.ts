/**
 * Every stage reads session.json, works, and writes it back. Two runs in one workspace overwrite
 * each other's pins, leaving a workspace that describes neither run. A crashed run must not make
 * the workspace unusable either, so the lock it left behind is taken over rather than obeyed.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkspaceLock, lockPath } from '../src/session/lock.js';

const workspace = (): string => mkdtempSync(join(tmpdir(), 'dai-lock-'));

describe('one run at a time in a workspace', () => {
  it('records the holder and releases it again', () => {
    const dir = workspace();
    const lock = acquireWorkspaceLock(dir, 'convert');
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8'))).toMatchObject({ pid: process.pid, command: 'convert' });
    lock.release();
    expect(existsSync(lockPath(dir))).toBe(false);
    // releasing twice is harmless, which is what the exit handler relies on
    expect(() => lock.release()).not.toThrow();
  });

  it('locks a workspace before init creates the directory', () => {
    const parent = workspace();
    const dir = join(parent, 'not-created-yet');
    const lock = acquireWorkspaceLock(dir, 'init');
    expect(existsSync(dir)).toBe(false);
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8'))).toMatchObject({ command: 'init', token: expect.any(String) });
    expect(() => acquireWorkspaceLock(dir, 'init')).toThrow(/workspace is in use/);
    lock.release();
  });

  it('refuses a workspace a live run holds, naming that run', () => {
    const dir = workspace();
    // a live holder that is not this process: pid 1 always exists
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 1, command: 'acquire', at: '2026-01-01T00:00:00.000Z' }));
    expect(() => acquireWorkspaceLock(dir, 'convert')).toThrow(/in use by pid 1 running "acquire"/);
  });

  it('takes over the lock a crashed run left behind, and says so', () => {
    const dir = workspace();
    // a pid that cannot be running: the kernel rejects it as out of range
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 2 ** 30, command: 'inventory', at: '2026-01-01T00:00:00.000Z' }));
    const lock = acquireWorkspaceLock(dir, 'convert');
    expect(lock.tookOver).toMatchObject({ pid: 2 ** 30, command: 'inventory' });
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8'))).toMatchObject({ pid: process.pid });
    lock.release();
  });

  it('treats an unreadable lock as stale rather than blocking the workspace forever', () => {
    const dir = workspace();
    writeFileSync(lockPath(dir), 'not json');
    const lock = acquireWorkspaceLock(dir, 'verify');
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8'))).toMatchObject({ command: 'verify' });
    lock.release();
  });

  it('does not remove a replacement lock it no longer owns', () => {
    const dir = workspace();
    const lock = acquireWorkspaceLock(dir, 'verify');
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, command: 'replacement', at: '2026-09-13T00:00:00.000Z', token: 'different-owner' }));
    lock.release();
    expect(existsSync(lockPath(dir))).toBe(true);
  });
});
