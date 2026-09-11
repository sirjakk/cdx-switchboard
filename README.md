# cdx-switchboard

Save several Codex accounts on each computer, switch by name or number, and
run concurrent sessions with coordinated token refresh. Python 3.11+ on macOS
or Linux, with no third-party Python packages.

## Install and enable

Run on each computer separately:

```sh
./install.sh
cdx setup --t3
cdx doctor
```

The installer puts `cdx` and `cdx-codex` in `~/.local/bin`, with the application
under `~/.local/share/cdx-switchboard/app`. It refuses to overwrite unrelated
commands. `XDG_BIN_HOME` and `XDG_DATA_HOME` override those locations.

`cdx setup` enables managed sessions and imports the current plain Codex login
once, preserving newer credentials. Existing saved accounts remain available.
After setup, the saved account vault owns managed authentication. Plain `codex`
still uses the original credential file and bypasses refresh coordination;
use `cdx` for terminal sessions.

`--t3` connects T3's default Codex provider to `~/.local/bin/cdx-codex` and saves
the original settings in `t3-settings-before-managed.json` in the cdx data
directory. If a T3 turn is running, a detached helper waits until turns finish
before changing settings. Its status is in `t3-integration.json`. The helper
waits up to 24 hours; rerun setup if its status is `pending` or `failed`.
Custom provider homes require their own configuration and are not overwritten.

## Accounts on multiple computers

Sign into each account once **on each computer**:

```sh
cdx login
cdx login                  # repeat for another account
cdx list
```

Each computer keeps an independent login for the same account. You can select
the same account on both computers or use different accounts. A switch is local
to the computer where you run it. Both computers still consume the account's
shared usage limits.

Do not copy or synchronize `auth.json` or the account vault between computers.
Synchronize application code separately. An account already revoked by OpenAI
needs one fresh login on the affected computer:

```sh
cdx repair                 # walks through only unrecoverable saved logins
cdx relogin support        # renew one named account
```

For SSH login, cdx prints a callback tunnel command. Run the tunnel in another
terminal on the computer with your browser, open the authorization URL, and
sign into the intended account. Stop the tunnel after login completes. If your
organization enables device authorization, `cdx login --device` and
`cdx repair --device` are alternatives.

Login happens in a private staging directory. Cancellation preserves the old
login. Relogin verifies the account identity before replacing credentials.

## Daily use

```sh
cdx rank                   # current usage, limits, and saved ranking numbers
cdx use 1                  # select row 1 for new sessions
cdx use support            # select by alias, without a network request
cdx use best               # refresh usage and select the best usable account
cdx                        # open managed Codex in this terminal
cdx switch support         # select account and restart T3
cdx current
```

`cdx use` does not stop or block on running processes. Existing managed sessions
stay on their selected account. New processes use the new selection. T3 can
reuse a process for an existing thread; `cdx switch` restarts T3 when you want
that thread to use the new account. This ends running turns. After reconnecting,
reopen the thread and say `continue`.

On Linux, `cdx switch` uses a detached systemd user service. On macOS it uses a
detached helper and the T3 application bundle. T3 is restarted even if account
selection fails. The latest handoff log is at
`$XDG_RUNTIME_DIR/cdx-switchboard/last-switch.log`, or a private temporary
directory when XDG runtime storage is unavailable.

Flags pass through to the interactive launcher. Use `cdx-codex` for other Codex
subcommands, or `CDX_ACCOUNT` to pin a command without changing the default:

```sh
cdx --model gpt-5.6-sol
cdx-codex resume
CDX_ACCOUNT=support cdx-codex exec 'Explain this repository'
```

## Concurrent sessions

Each managed Codex process gets a private authentication snapshot and stays on
that account. Normal configuration, skills, and conversation history are shared
with the original Codex home. Switching accounts does not overwrite a running
process's authentication.

When Codex needs to refresh, its local callback asks cdx to acquire a file lock
for the saved account. The original Codex binary refreshes and saves tokens in
that account's vault. Other workers receive the updated tokens. Only one helper
refreshes an account at a time, and a late worker write cannot replace newer
vault credentials. Ranking and relogin use the same account lock.

The callback listens only on loopback, uses a random private path, and accepts
only refresh tokens issued to that runtime. Codex itself performs OAuth; cdx
does not embed OAuth client IDs. A managed worker's logout ends that worker's
login without revoking the saved login used by other workers.

This integration uses Codex's `CODEX_REFRESH_TOKEN_URL_OVERRIDE` and
`CODEX_REVOKE_TOKEN_URL_OVERRIDE` hooks plus `account/read`. It was tested with
Codex 0.153.4 on Arch and 0.144.1 and 0.154.0 on macOS. Recheck the diagnostic after Codex
upgrades. Plain `codex` processes and T3 providers using another binary bypass
this coordination. Server-side revocation can still require a fresh login.

## Ranking and recovery

`cdx rank` asks Codex's `account/rateLimits/read` for usage. On authentication
failure it requests one refresh and retries. An unrecoverable login shows
`cdx relogin <alias>` rather than a multiline HTTP error.

Usable accounts rank by the highest remaining percentage in their most
constrained window. Ties prefer more long-window budget, then earlier reset
times. Exhausted accounts and errors go last. `SPEND LIMIT` means the server
reports a spending cap, even when five-hour or weekly percentages remain.
Relogin cannot remove that cap.

Switching by alias remains available offline. `cdx doctor --verbose` checks
installation and credential permissions. Login, relogin, rank, and use never
delete saved accounts.

## Storage and testing

```text
~/.local/share/cdx-switchboard/
  managed.json
  active.json
  last-rank.json
  accounts/<random-id>/
    account.json
    auth.json
    refresh.lock
  runtimes/session-*/       # private credentials, removed on normal exit
```

Vault directories use mode `0700` and credentials use `0600`. Never commit,
paste, or synchronize their contents. `CDX_SWITCHBOARD_HOME` selects a separate
vault for tests. `CDX_CODEX_BIN` selects the original Codex binary.

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
python3 scripts/check-refresh-concurrency.py
python3 scripts/check-refresh-concurrency.py --managed
```

The diagnostic uses temporary synthetic credentials and a local mock OAuth
server. It compares separate processes sharing an account, requests within one
process, and independent logins for the same user. Managed mode exits with an
error if tokens are reused or authentication fails. It does not test OpenAI's
revocation policy. See [investigation notes](docs/auth-investigation.md).
