# Account and concurrency investigation

## Mac version selection, September 11

The Mac had two npm installations. `/opt/homebrew/bin/codex` ran 0.144.1,
while `~/.nvm/versions/node/v24.18.0/bin/codex` ran 0.154.0. A non-interactive
login shell selected the former; interactive shells loaded NVM from `.zshrc`
and selected the latter. Managed cdx configuration also selected the older
absolute Homebrew path. The earlier alternating version reports did not
establish an actual downgrade; executable selection reproduces them.

The Homebrew-prefix npm installation was updated explicitly to 0.154.0. The
NVM command symlink now forwards to `/opt/homebrew/bin/codex`, so cached command
paths and new shells reach the same installation. Its old package files remain
available to processes already running. No login credentials were changed.
The previous symlink target is recorded locally in the cdx installation backup.
An explicit future npm installation under NVM could recreate a separate command.
Version 0.2.1 makes `cdx doctor` report distinct installations and actual versions.

The Mac's T3 configuration was also found missing its managed launcher after
an earlier successful setup. The writer that removed it has not been identified.
Doctor now checks the current settings instead of accepting the saved
`connected` status as proof of an active integration.

Investigated on September 10, 2026, on the main Mac and Arch Linux PC.

## Confirmed switchboard defect

A regular `codex login` could change the live identity while `active.json`
still named another account. The old sync method rejected this mismatch and
never saved the newer login to its own vault entry. A subsequent `cdx use`
could restore an older, revoked login. The default launcher also recopied a
vault snapshot over the existing live login.

Version 0.1.6 reconciles known live identities before switching, listing,
ranking, or selecting a default relogin account. The launcher preserves an
existing live auth file. Regression tests cover switching away and back after
a regular Codex login and launching an account not yet stored in the vault.

## Arch thread errors

Retained T3 provider logs contain `token_revoked` errors in multiple threads,
including September 5, 9, and 10. The boot log also contains
`refresh_token_invalidated`. The inspected errors say the refresh token was
revoked, not that it was already used. These logs alone do not establish what
revoked the sessions.

Arch runs T3 `0.0.41-nightly.20260910.1507` and Codex `0.153.4`. Inspection of
the deployed T3 runtime confirms it constructs separate Codex session runtimes
and passes the configured Codex home to each. The diagnostic reproduced two
processes submitting the same synthetic refresh token concurrently, leaving
one authentication request unsuccessful.

The upstream Codex auth manager uses a semaphore within a process, then checks
the disk copy before refreshing. That check does not serialize refreshes in
different processes. The reproduction exercises the installed binary, rather
than relying only on current upstream source.

This is a demonstrated refresh race and a plausible contributor to the T3
failures. It is not proof of the cause of every historical revocation, and
version 0.1.6 did not patch T3 or Codex's refresh implementation.

## Managed sessions in version 0.2.0

The managed launcher gives each process its own auth snapshot, pinned to a saved
account. Local refresh callbacks coordinate through that account's file lock.
The original Codex binary owns refresh and persistence in the canonical vault;
workers receive the latest tokens and write only to their private snapshots.
The helper inherits the lock so a killed wrapper cannot release it while the
helper is still refreshing. Ranking and relogin share this coordination.

On both tested binaries, the managed diagnostic's two concurrent processes
authenticate successfully with one upstream refresh request and no token reuse.
Requests within one process and independent logins also succeed. Unit tests
cover concurrent refresh, stale worker writes, account switching, relogin,
callback authentication, and nested commands. These are synthetic checks, not
proof that a real account cannot be revoked or hit its spending limits.

T3 uses the installed `cdx-codex` binary through its provider settings. Setup
defers the settings change while turns are running because T3 closes affected
provider processes when configuration changes. No T3 source patch is required.

## Cross-computer behavior

The currently saved matching accounts have different refresh tokens and
different session claims on the two computers. The current Mac live login is
also independent of the matching Arch login. Identifiers were compared in
memory; no tokens or session identifiers were printed or saved in this report.

`cdx use <alias>` performs local file operations and has no remote logout or
revocation call. `cdx use best` additionally queries usage. No authentication
synchronization was found in the inspected switchboard or fleet scripts.
The reported Mac-switch/Arch-break sequence has not been reproduced against
the real accounts. No live T3 service was restarted for this investigation.
