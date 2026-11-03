// Restart T3 around an account switch, from a helper that outlives T3.
//
// `cdx switch` is often run by an agent inside T3. Stopping T3 ends that
// agent's process tree, so the work is done by a detached helper: it stops
// T3, switches, checks the result with a fresh Codex process, and starts T3
// again. T3 is restarted even if the switch fails.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdxError, ensurePrivateDir } from "./files.js";
import { withLock } from "./lock.js";
import { type T3, waitFor } from "./t3.js";

const HELPER_UNIT = "cdx-switchboard-handoff";

export function runDirectory(dataHome: string): string {
  return ensurePrivateDir(path.join(dataHome, "run"));
}

export function logPath(dataHome: string): string {
  return path.join(dataHome, "run", "last-switch.log");
}

function operationLock(dataHome: string): string {
  return path.join(runDirectory(dataHome), "handoff.lock");
}

/** Fail now, in the foreground, if a switch or restart is already in progress. */
export async function ensureIdle(dataHome: string): Promise<void> {
  await withLock(operationLock(dataHome), () => undefined, {
    waitMs: 0, busyMessage: `another switch is in progress; see ${logPath(dataHome)}`,
  });
}

/**
 * Start `cdx <helper> [args]` detached from this process tree. On Linux it
 * runs as its own systemd user unit, outside T3's service, so stopping T3
 * cannot stop it.
 */
export function scheduleHelper(helper: string, args: string[], env: NodeJS.ProcessEnv, useSystemd: boolean): void {
  const entry = fileURLToPath(new URL("./bin.js", import.meta.url));
  const command = [process.execPath, entry, helper, ...args];
  if (useSystemd) {
    const settings = Object.entries(env)
      .filter(([name, value]) => value !== undefined && /^(PATH|HOME|CODEX_HOME|CDX_[A-Z_]+|XDG_DATA_HOME|T3CODE_HOME)$/.test(name))
      .map(([name, value]) => `--setenv=${name}=${value}`);
    const result = spawnSync("systemd-run", [
      "--user", `--unit=${HELPER_UNIT}`, "--collect", "--quiet", "--property=Type=exec", ...settings, ...command,
    ], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 15_000 });
    if (result.error || result.status !== 0) {
      throw new CdxError(`systemd could not start the switch helper: ${(result.stderr ?? result.error?.message ?? "").trim()}`);
    }
    return;
  }
  const child = spawn(command[0]!, command.slice(1), { env, detached: true, stdio: "ignore" });
  child.unref();
}

export interface HandoffSteps {
  t3: T3;
  /** Change the live login. Returns a description for the log. */
  change(): Promise<string>;
  /** Throw if Codex does not now sign in as the chosen account. */
  verify(): Promise<void>;
}

/** Run in the helper: stop T3 if it runs, change the login, verify, start T3 again. */
export async function performHandoff(dataHome: string, steps: HandoffSteps, { settleMs = 2000, timeoutMs = 60_000 } = {}): Promise<void> {
  const file = logPath(dataHome);
  const log = (event: string) => fs.appendFileSync(file, `${new Date().toISOString()} ${event}\n`, { mode: 0o600 });
  try {
    await withLock(operationLock(dataHome), async () => {
      fs.writeFileSync(file, "", { mode: 0o600 });
      log("helper started");
      // Let the command that scheduled this print its result before T3 stops.
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      let stopped = false;
      let failure: unknown;
      try {
        if (steps.t3.running()) {
          stopped = true;
          steps.t3.stop();
          waitFor(steps.t3, false, timeoutMs);
          log("T3 stopped");
        } else {
          log("T3 is not running; switching without a restart");
        }
        log(await steps.change());
        await steps.verify();
        log("verified: Codex signs in as the chosen account");
      } catch (error) {
        failure = error;
        log(`switch failed: ${(error as Error).message}`);
      } finally {
        if (stopped) {
          try {
            steps.t3.start();
            waitFor(steps.t3, true, timeoutMs);
            log("T3 started");
          } catch (error) {
            failure ??= error;
            log(`T3 did not start again: ${(error as Error).message}; open T3 yourself`);
          }
        }
      }
      if (failure) throw failure;
      log("done");
    }, { waitMs: 0, busyMessage: "another switch is already in progress" });
  } catch (error) {
    try {
      log(`failed: ${(error as Error).message}`);
    } catch {
      // Nowhere left to report it.
    }
    throw error;
  }
}
