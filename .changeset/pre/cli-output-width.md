---
"hot-updater": patch
---

Make the CLI's human output shorter and easier to read. `--json` is unchanged.

- Messages say what is wrong and one next step. Doctor, `secrets`, `deploy`, and the secrets adapters drop sentences that restated a line, explained internals, or applied only rarely.
- `p` wraps prose at word boundaries. A command, a URL, or a path stays whole on its own line, however long: no command is split with ` \` any more, so each one copies as printed. Text a tool wrote, such as a build's output, prints as the tool wrote it.
- An error or a warning shows a provider's message instead of its raw JSON, such as Cloudflare's `errors[].message`: doctor now says `Could not check the release catalogs: 401 Authentication error`.
- `secrets put --kind android-keystore` without a terminal refuses once, listing all it needs: `--key-alias` and the password variables that aren't set.
- An unexpected failure in `deploy`, `patch`, or `fingerprint` prints its message as an error. `DEBUG=1` adds the stack.
