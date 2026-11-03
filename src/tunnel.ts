// Browser sign-in on a computer reached over SSH.
//
// Codex's browser login finishes by redirecting the browser to a localhost
// port on the computer running Codex. When the browser is on another
// computer, an SSH tunnel carries that redirect back.

import os from "node:os";
import type { Config } from "./store.js";

function quote(value: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** True when the browser is probably on another computer. */
export function remoteSession(config: Config, env = process.env): boolean {
  if (config.ssh_host || env.SSH_CONNECTION || env.SSH_TTY) return true;
  return process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export function tunnelCommand(host: string, port: number, config: Config, env = process.env): string {
  const connection = (env.SSH_CONNECTION ?? "").split(" ");
  let target = config.ssh_host;
  let sshPort = "22";
  if (!target && connection.length === 4) {
    target = connection[2]!;
    sshPort = connection[3]!;
  }
  target ??= os.hostname();
  if (target.includes(":") && !target.startsWith("[")) target = `[${target}]`;
  if (!target.includes("@")) target = `${os.userInfo().username}@${target}`;
  const address = host.includes(":") ? `[${host}]` : host;
  const args = ["ssh", "-o", "ExitOnForwardFailure=yes", ...(sshPort !== "22" ? ["-p", sshPort] : []),
    "-N", "-L", `${address}:${port}:${address}:${port}`, target];
  return args.map(quote).join(" ");
}

export function printTunnelHelp(host: string, port: number, config: Config): void {
  console.log([
    "",
    "To sign in with a browser on another computer, run this there in a second terminal:",
    "",
    `  ${tunnelCommand(host, port, config)}`,
    "",
    "Keep it running, then open the sign-in URL above in that computer's browser.",
    "When cdx says you are signed in, stop the tunnel with Ctrl-C.",
    `If port ${port} is busy there, close the old tunnel first. Or use \`--device\` to sign in with a code instead.`,
    config.ssh_host ? "" : "If that host name is wrong, set the right one with `cdx config ssh-host <host>`.",
    "",
  ].join("\n"));
}
