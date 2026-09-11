# cdx-switchboard

`cdx-switchboard` is a small, dependency-free account switcher for the OpenAI
Codex CLI. It is built for a person who owns several Codex-enabled accounts and
works primarily over SSH.

It is an independent implementation. The three main commands are:

```text
cdx login              # one-time browser login through an SSH tunnel
cdx rank               # asks Codex for current limits and recommends an account
cdx use 1              # switches to row 1 from the latest ranking
```

You can also run `cdx use best`, or run `cdx use` interactively to rank and
choose by number.

When working inside T3, `cdx switch [account]` performs a complete unattended
handoff. On Linux it schedules an independent systemd user service; on macOS it
starts a detached helper. The helper stops T3, selects the requested account
(or the best usable account when omitted), verifies it, and restarts T3 even if
switching fails. This is a disruptive command: the current T3 connection and
Codex process will stop. It does not resume the exact thread automatically;
after T3 reconnects, reopen the thread and say `continue`.

Only the most recent handoff log is retained, normally at
`$XDG_RUNTIME_DIR/cdx-switchboard/last-switch.log`. If no XDG runtime directory
is available, cdx uses a private, user-specific temporary directory instead.
The helper records timestamps and high-level outcomes only, never credentials.
On macOS, the helper waits for both the T3 window process and its backend server
to exit before replacing `auth.json`; a backend that is still shutting down is
not mistaken for a separate active session.

## Why this design is safer

- Login happens in an isolated staging directory. A cancelled or failed login
  never deletes or overwrites the active Codex credentials.
- Browser authentication is the default. The CLI prints the SSH tunnel command
  needed to carry Codex's localhost callback from your browser to the server.
- Account switches use an inter-process lock, identity checks, private file
  permissions, and atomic file replacement.
- Relogin refuses to replace an account if the newly authenticated JWT belongs
  to a different user.
- `cdx rank` calls the installed `codex app-server` method
  `account/rateLimits/read`. After an authentication failure it requests
  `account/read` with `refreshToken: true`, then retries usage once. Codex owns
  token refresh and server compatibility;
  this project does not embed OAuth client IDs or call private ChatGPT endpoints.
- The live Codex token is copied back only to its matching stored account
  and is newer, which protects refresh-token rotation.
- Regular `codex login` is recognized by the live credential identity, even
  when the switchboard's active marker still names another account. Before
  switching, cdx saves the newer login to its matching vault entry. Launching
  `cdx` preserves an existing live login, including one not yet in the vault.
- `cdx use`, `cdx login`, and `cdx relogin` do not block based on running
  processes. An idle background process does not prove an account is busy.
  `cdx use` updates the login on disk; an existing session can keep its cached
  account until restarted. `cdx switch [account]` also restarts T3.
- Ranking an active account whose identity matches the live login uses the
  canonical Codex home, regardless of running processes, and allows the
  app-server to exit cleanly, preserving any refresh-token rotation before the
  credentials are synchronized back to the switchboard vault.

OpenAI documents browser authentication as the normal `codex login` flow and
documents file credentials at
[`~/.codex/auth.json`](https://developers.openai.com/codex/auth).

## Requirements

- Linux or macOS
- Python 3.11+
- A recent `codex` CLI with `codex app-server`
- An SSH client with local port forwarding
- systemd user services (`systemd-run --user` and `systemctl --user`) for
  `cdx switch` on Linux; the T3 application bundle on macOS

No Python packages are required.

## Install

From this repository:

```sh
./install.sh
cdx doctor
```

The installer copies the application to
`${XDG_DATA_HOME:-~/.local/share}/cdx-switchboard/app` and links `cdx` into
`${XDG_BIN_HOME:-~/.local/bin}`. It does not modify an existing Codex login or
install Python dependencies. It also refuses to replace an unrelated existing
`cdx` executable; move that command aside explicitly if you want to replace it.

You can test the repository without installing it:

```sh
./cdx --help
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

## Initial setup over SSH

If the machine already has a Codex login you want to keep, import it first:

```sh
cdx import-current existing
```

This is also done automatically before the first newly logged-in account is
activated.

Then add each account once:

```sh
cdx login
cdx list
```

Repeat `cdx login` for each additional account.

For every login, `cdx` prints a tunnel command similar to this:

```sh
ssh -N -L 1455:127.0.0.1:1455 sirjak@your-server
```

Run it in a second terminal on the computer with your browser and leave it
running. Back in the remote terminal, open the authorization URL printed by
Codex and sign into the intended account. The browser callback travels through
the tunnel to Codex on the remote machine. Stop the tunnel with Ctrl-C after
login finishes. Each account is named automatically from its email address.

If an administrator has enabled device authorization, `cdx login --device`
remains available as an alternative.

## Daily workflow

```sh
cdx rank
cdx use 1
cdx                         # launches Codex with the active account
```

Useful variations:

```sh
cdx use personal            # alias
cdx use name@example.com    # email
cdx use best                # refresh ranking and switch automatically
cdx use                     # interactive rank-and-prompt flow
cdx switch support          # safely hand T3 to a named account
cdx switch                  # safely hand T3 to the best account
cdx relogin personal        # renew one stored login safely
cdx current
cdx rank --json
```

Arguments beginning with `-` pass through when `cdx` launches Codex:

```sh
cdx --model gpt-5.6-sol
```

`cdx` forces Codex's file credential store for consistent account switching
while preserving the rest of the normal `~/.codex` configuration. If you run
plain `codex` and have explicitly configured keyring-only credentials, that
plain invocation may not see the account selected by `cdx use`; use the `cdx`
launcher instead.

## Storage

Account credentials and metadata live under:

```text
~/.local/share/cdx-switchboard/
  active.json
  last-rank.json
  accounts/<random-id>/
    account.json
    auth.json
```

Directories are mode `0700`; credential files are mode `0600`. Treat this
directory like a password vault. Never commit, paste, or share its contents.

For isolated testing, set `CDX_SWITCHBOARD_HOME`. To use another Codex binary,
set `CDX_CODEX_BIN`.

## Ranking behavior

Ranking intentionally stays simple and explainable:

1. Accounts with a server error, exhausted limits, or no usable window go last.
2. The account with the highest remaining percentage on its most constrained
   window ranks first.
3. Ties prefer more remaining long-window budget, then the budget that resets
   sooner so expiring capacity is less likely to be wasted.

The table shows every returned window, its remaining percentage, reset time,
plan, active account, and reset-credit count. `cdx use <number>` uses the order
saved by the latest `cdx rank`.
`SPEND LIMIT` means the server reports that a spending control was reached,
even if the five-hour or weekly window still has room.

## Recovery

- A 401 triggers one Codex-managed refresh and retry. If that login cannot be
  recovered, the ranking row shows `cdx relogin <alias>` instead of a multiline
  HTTP error. A revoked refresh token requires another browser login.
- `cdx relogin <alias>` stages a fresh login and verifies identity before
  replacing the stored credentials.
- `cdx doctor --verbose` checks the Codex binary, active account, credential
  permissions, and keyring configuration.
- Stored accounts are never deleted by login, relogin, rank, or use.
- If the ranking protocol changes in a future Codex release, switching by alias
  remains available offline.

## Using the same accounts on two computers

Log into each account separately on each computer with `cdx login` or
`cdx relogin <alias>`. Use the SSH callback tunnel or `--device` on the remote
computer. Each computer keeps its own credential vault and refresh history.
Do not routinely synchronize `auth.json` or the `accounts` directory between
computers. Copying an older login back after token rotation can restore stale
credentials. Synchronize the application code separately from account data.

### Concurrent T3 threads

T3 can start separate Codex app-server processes for different threads. In the
tested Codex versions, simultaneous refreshes in separate processes can submit
the same refresh token twice. The switchboard's file lock does not coordinate
Codex's own refresh requests. Removing process-based switch blocks does not fix
that underlying race.

Run the isolated diagnostic with the installed Codex CLI:

```sh
python3 scripts/check-refresh-concurrency.py
```

It compares two processes sharing one home, two requests in one process, and
two processes with independent synthetic logins. It uses temporary credentials
and a local mock OAuth server; it does not read real logins or test OpenAI's
revocation policy. See [investigation notes](docs/auth-investigation.md).
