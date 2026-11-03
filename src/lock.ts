// Cross-process locks that the operating system releases if cdx crashes.
//
// Node has no flock(). SQLite does: an exclusive transaction holds a real
// file lock, which the kernel drops when the process exits, so a crashed
// command can never leave a stale lock behind.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CdxError } from "./files.js";

const held = new Set<string>();

export interface LockOptions {
  /** How long to wait for another cdx command. 0 fails immediately. */
  waitMs?: number;
  /** Printed once if the lock is busy and cdx starts waiting. */
  waitingMessage?: string;
  busyMessage?: string;
}

function busy(error: unknown): boolean {
  const { errcode, message } = error as { errcode?: number; message?: string };
  return (errcode !== undefined && (errcode & 0xff) === 5) || /database is locked/i.test(message ?? "");
}

function tryLock(db: DatabaseSync, waitMs: number): boolean {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`);
  try {
    db.exec("BEGIN EXCLUSIVE");
    return true;
  } catch (error) {
    if (busy(error)) return false;
    throw error;
  }
}

/**
 * Run fn while holding the lock at `file`. Re-entrant within this process,
 * so nested helpers that take the same lock cannot deadlock.
 */
export async function withLock<T>(file: string, fn: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  if (held.has(file)) return await fn();
  const waitMs = options.waitMs ?? 120_000;
  fs.closeSync(fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600));
  const db = new DatabaseSync(file);
  try {
    if (!tryLock(db, 0)) {
      if (waitMs <= 0) throw new CdxError(options.busyMessage ?? "another cdx command is running; try again shortly");
      if (options.waitingMessage) process.stderr.write(options.waitingMessage + "\n");
      if (!tryLock(db, waitMs)) {
        throw new CdxError(options.busyMessage ?? "another cdx command is still running; try again shortly");
      }
    }
    held.add(file);
    try {
      return await fn();
    } finally {
      held.delete(file);
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}
