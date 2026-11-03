// Private files: every credential cdx writes goes through atomicWrite.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** An expected failure, shown to the user as one line without a stack trace. */
export class CdxError extends Error {}

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY } = fs.constants;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Create a directory only this user can read, refusing symlinks and foreign owners. */
export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CdxError(`${dir} must be a directory, not a link or file`);
  }
  if (stat.uid !== process.getuid!()) {
    throw new CdxError(`${dir} belongs to another user`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * Replace a file atomically: readers see the old or the new content, never a
 * mix. The temporary file is created private, so a secret is never briefly
 * readable by others, and a symlink at the destination is replaced, not followed.
 */
export function atomicWrite(file: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
  try {
    try {
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  syncDir(dir);
}

function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Not every filesystem supports syncing a directory; the rename is still atomic.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function writeJson(file: string, value: unknown, mode = 0o600): void {
  atomicWrite(file, JSON.stringify(value, null, 2) + "\n", mode);
}

/** Read a regular file without following a symlink. Returns undefined if missing. */
export function readPrivate(file: string): Buffer | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new CdxError(`${file} is a symbolic link; cdx only manages a regular file there`);
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new CdxError(`${file} is not a regular file`);
    if (stat.size > MAX_JSON_BYTES) throw new CdxError(`${file} is unexpectedly large`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse JSON without ever echoing its content: V8's parse errors quote the
 * input, and these files can hold tokens.
 */
export function parseJson(data: Buffer | string, label: string): unknown {
  try {
    return JSON.parse(data.toString());
  } catch {
    throw new CdxError(`${label} is not valid JSON`);
  }
}

export function readJson(file: string): unknown {
  const data = readPrivate(file);
  return data === undefined ? undefined : parseJson(data, file);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
