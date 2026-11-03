#!/usr/bin/env node
// codex-switchboard launcher: the `cdx` command.

// node:sqlite, used for crash-safe locks, prints an "experimental" warning on
// some Node versions. Hide only that warning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (/SQLite/i.test(String((warning as Error)?.message ?? warning))) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import("./cli.js");
const { CdxError } = await import("./files.js");

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const { code, path } = error as NodeJS.ErrnoException;
  if (error instanceof CdxError) {
    process.stderr.write(`cdx: ${error.message}\n`);
  } else if (code === "EPERM" || code === "EACCES" || code === "EROFS") {
    // The usual cause is an agent sandbox that cannot write outside the project.
    process.stderr.write(`cdx: not allowed to write ${path ?? "a file it needs"}. `
      + "If an AI agent ran this inside a sandbox, run it with permission to write outside the project.\n");
  } else {
    process.stderr.write(`cdx: unexpected error: ${(error as Error)?.stack ?? error}\n`);
  }
  process.exitCode = 1;
}
