# codex-switchboard

`cdx` switches the [OpenAI Codex CLI](https://github.com/openai/codex) between
your ChatGPT accounts, for example a personal and a work account, without
signing out and back in. Threads keep their full history across switches, so
you can continue a conversation on another account when one runs out of usage.

```sh
# Install from GitHub using the steps below.
cdx login          # once per account
cdx rank           # usage left on every account
cdx switch         # move Codex to the account with the most usage left
```

It works in a terminal, over SSH, and with [T3 Code](https://t3.codes), which it
restarts onto the new account.

## Requirements

- macOS or Linux. On Windows, use WSL.
- Node.js 22.13 or newer.
- The Codex CLI, installed any way (npm, Homebrew, or the standalone installer).

## Installing and updating cdx from GitHub

The source of truth is `sirjakk/cdx-switchboard`, branch `main`.
Both computers keep their only source checkout at `~/cdx-switchboard`.
This package is private and is not published to the npm registry.

For the first installation, clone the repository:

```sh
git clone git@github.com:sirjakk/cdx-switchboard.git ~/cdx-switchboard
```

After editing on either computer, test, commit and push to GitHub. On the
other computer, pull and reinstall locally:

```sh
cd ~/cdx-switchboard
git pull --ff-only origin main
npm ci
npm test
npm pack --silent
# On Arch:
npm install -g --prefix "$HOME/.local" ./codex-switchboard-1.0.0.tgz
# On the Mac, use this instead:
# /opt/homebrew/bin/npm install -g ./codex-switchboard-1.0.0.tgz
rm ./codex-switchboard-1.0.0.tgz
```

Use the tarball filename printed by `npm pack` if the version changes.
The tarball is built and installed on the same computer. Do not copy packages
between computers. `npm pack` builds the program; it does not publish it.
Arch can also run `crewfleet update --only cdx --archlinux`, which pulls,
tests, builds and installs the Git commit and skips it on later runs.
`cdx update` updates Codex itself, not this cdx source repository.

Source, tests, dependency lockfile and documentation belong in Git. Generated
`dist/`, `node_modules/`, `.test-build/` and tarballs are ignored. The installed
npm copy is a build of this repository, not another source checkout. Saved
accounts and machine settings stay outside the repository and are never synced.
The former Python implementation is preserved in Git history.

## How it works

Codex reads one login: `~/.codex/auth.json`. Every Codex process on a computer
uses that folder, and it is also where Codex keeps thread history.

cdx keeps a private copy of each account's login and switches by replacing
`auth.json` in one atomic step. Thread history never moves, so any thread can
be resumed on any account. (Tools that give each account its own `CODEX_HOME`
split your history between folders instead.)

Codex rotates refresh tokens: each refresh makes the previous token invalid.
So before every change, cdx saves the login Codex is using now, so its saved
copy is always the newest one. A login cdx has not seen before is saved as a
new account, never overwritten.

## Commands

| Command | What it does |
| --- | --- |
| `cdx rank [--json]` | Shows usage left on every account, best first |
| `cdx switch [account]` | Switches to an account (default: the one with the most usage left) and restarts T3 if it is running |
| `cdx use <account>` | Switches without restarting T3 |
| `cdx restart` | Restarts T3 so it uses the current account |
| `cdx list` | Lists saved accounts (no network) |
| `cdx current` | Shows the account Codex is signed in as |
| `cdx login` | Signs in to an account, saves it, and switches to it. `--device` signs in with a code; `--with-api-key` reads an API key from stdin; `--alias <name>` names it |
| `cdx relogin [account]` | Signs in again to an account whose login expired |
| `cdx repair` | Signs in again to every account whose login expired |
| `cdx reset [account]` | Uses a usage reset credit, then switches to that account |
| `cdx rename <account> <alias>` | Renames a saved account |
| `cdx remove <account>` | Deletes a saved account from this computer |
| `cdx import-current [alias]` | Saves the login Codex is using now |
| `cdx update [--check]` | Updates the Codex CLI (npm installs) and restarts T3 |
| `cdx config` | Shows or changes settings (see below) |
| `cdx doctor` | Checks the setup |
| `cdx [codex options]` | Starts Codex, like `codex` (except `--help` and `--version`, which are cdx's) |

An account is its alias, its email, or its number in the last `cdx rank`.

`cdx switch` checks that the account has usage left before changing anything.
API-key accounts are billed per use, so `cdx switch` never picks one on its
own; name it to switch to it.

## Sign in only through cdx

Use `cdx login` to add accounts, not `codex login` or `codex logout`. Codex
revokes the signed-in login before it signs in or out, which also makes cdx's
saved copy of that account stop working. If that happens, `cdx relogin
<account>` fixes it.

## Codex sessions that are already running

A running Codex process keeps the account it started with in memory until it
exits. Don't leave it running on the old account:

- **T3:** `cdx switch` restarts T3 for you. If you run it from a T3 thread,
  that turn ends. Reopen the thread after T3 reconnects and say "continue";
  it keeps its history.
- **Terminal:** exit Codex sessions before you switch, or right after, then
  run `codex resume` to continue on the new account. A session left running
  on the old account can still refresh that account's login and write it
  into `auth.json`. cdx detects this and repairs it the next time it runs,
  but exiting avoids it.
- **Agents:** an agent that runs `cdx` inside Codex's sandbox needs permission
  to write outside the project (cdx changes `~/.codex/auth.json`) and to use
  the network.

On macOS, cdx controls the T3 desktop app. On Linux, it controls the
`t3code.service` user service that T3's headless install creates. If T3 runs
some other way, restart it yourself after a switch, or turn this off with
`cdx config t3 off`. The last switch is logged in
`~/.local/share/cdx-switchboard/run/last-switch.log`.

## Over SSH

Codex's browser sign-in sends the browser to a `localhost` address on the
computer running Codex. Over SSH, `cdx login` prints an `ssh -L` command to run
on the computer with the browser, which forwards that address. Or sign in with
a code instead: `cdx login --device`.

If cdx guesses the wrong host name for that command, set it with
`cdx config ssh-host <host>`.

## Several computers

Each computer has its own saved logins and its own current account. You can
use the same account on two computers, or different ones. Sign in separately
on each computer. Don't copy `auth.json` or cdx's data folder between
computers: the copies share one refresh token, and when one computer refreshes
it, the other's copy stops working.

## Usage reset credits

`cdx reset` uses the available credit that expires soonest. It saves the
request's ID before sending it, so if the result is unclear (for example a
timeout), running the same command again retries the same request instead of
spending a second credit.

## Security

- Logins are stored in `~/.local/share/cdx-switchboard/accounts/` (or
  `$XDG_DATA_HOME/cdx-switchboard`), in folders only you can read (mode 700)
  and files only you can read (mode 600). They are plain files, like Codex's
  own `auth.json`; they are not encrypted.
- Files are written privately from the first byte and replaced atomically.
  cdx never follows a symbolic link when it reads or writes a login.
- cdx never prints, logs, or sends tokens. It talks to OpenAI only through
  your installed Codex CLI.
- Variables that would send tokens to another server
  (`CODEX_REFRESH_TOKEN_URL_OVERRIDE` and similar) are removed before cdx
  starts Codex for an account.
- Locks are held by the operating system, so a crashed command never leaves a
  stale lock and two commands never change logins at the same time.
- Before switching, cdx checks that Codex really reads its login from
  `auth.json`. If Codex keeps logins in the system keyring
  (`cli_auth_credentials_store`), cdx refuses, because switching the file
  would change nothing.
- cdx keeps a few backups in `backups/` in its data folder: a login it could
  not read, and a saved copy that a newer login replaced unexpectedly. They
  are private like the rest.
- `cdx remove` deletes cdx's copy only (it needs the exact alias or email). To
  end a login everywhere, sign out of ChatGPT on the web.

## Terms of use

Use cdx only with accounts that are yours, such as a personal and a work
account. OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use/)
forbid sharing account credentials and circumventing rate limits. You are
responsible for how you use your accounts.

## Settings

`cdx config <setting> <value>` changes a setting; `cdx config <setting> --unset`
restores the default.

| Setting | Meaning |
| --- | --- |
| `codex-path` | The Codex CLI to use, if cdx does not find the right one |
| `ssh-host` | The host name the browser computer uses to reach this one |
| `t3` | `off` stops cdx from restarting T3 |
| `t3-service` | The T3 user service on Linux (default `t3code.service`) |

These environment variables also apply: `CODEX_HOME` (Codex's folder, default
`~/.codex`), `CDX_SWITCHBOARD_HOME` (cdx's data folder), and `CDX_CODEX_BIN`
(the Codex CLI to use).

## Troubleshooting

Run `cdx doctor` first. It checks the Codex install, login storage, saved
accounts, and T3 settings.

- **A thread starts over after a switch:** check that T3 uses the same Codex
  home as your terminal. `cdx doctor` reports a T3 setting that points
  somewhere else.
- **`login expired`:** run `cdx relogin <account>`.
- **T3 did not come back after a switch:** see `last-switch.log` (path above),
  then open T3 yourself.

## Uninstall

```sh
npm uninstall -g codex-switchboard
rm -rf ~/.local/share/cdx-switchboard   # deletes cdx's saved logins
```

Codex stays signed in to the current account.

## Development

```sh
npm ci
npm test
```

The tests use a fake Codex CLI in temporary folders. They never touch your
real logins or T3.

## License

MIT
