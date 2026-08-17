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
  `account/rateLimits/read`. Codex owns token refresh and server compatibility;
  this project does not embed OAuth client IDs or call private ChatGPT endpoints.
- The live Codex token is copied back only when it matches the active account
  and is newer, which protects refresh-token rotation.
- Switching refuses while another Codex process appears active unless you pass
  `--force`. Switching under a live session can let that session overwrite the
  newly selected credentials later.

OpenAI documents browser authentication as the normal `codex login` flow and
documents file credentials at
[`~/.codex/auth.json`](https://developers.openai.com/codex/auth).

## Requirements

- Linux (the current process guard uses `/proc`; macOS can still run the core
  commands but does not yet get that guard)
- Python 3.11+
- A recent `codex` CLI with `codex app-server`
- An SSH client with local port forwarding

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

## Recovery

- `cdx relogin <alias>` stages a fresh login and verifies identity before
  replacing the stored credentials.
- `cdx doctor --verbose` checks the Codex binary, active account, credential
  permissions, and keyring configuration.
- Stored accounts are never deleted by login, relogin, rank, or use.
- If the ranking protocol changes in a future Codex release, switching by alias
  remains available offline.
