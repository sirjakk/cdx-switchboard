# cdx source

This is the source for the `codex-switchboard` npm package and `cdx` command.
GitHub `sirjakk/cdx-switchboard`, branch `main`, is the source of truth.
Use `~/cdx-switchboard` on both the Mac and Arch. Follow README.md for installation.

- Run `npm ci`, `npm test` and `npm run build` before installing a change.
- Push source changes to GitHub; other computers pull with `--ff-only` and build locally.
- Do not publish to npm or copy packages between computers.
- Do not commit account data, auth files, keys, or machine configuration.
- Tests use fake Codex and isolated homes. Never test with real logins, switches,
  reset credits, updates or T3 restarts.
- `cdx update` updates Codex, not cdx itself.
