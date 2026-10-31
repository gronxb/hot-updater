---
"hot-updater": patch
---

Keep the CLI's human output within 76 columns.

- `p` now fits every line it prints at print time, to 73 display columns after clack's 3-column gutter (70 in a note's box). Prose breaks at spaces, a command breaks with ` \`, which counts toward the width, and a word longer than a line, such as a URL or a path, gets a line of its own. Width is display width: East Asian wide characters and emoji take two columns. Text a tool wrote, such as a build's output, prints as the tool wrote it, and `--json` is unchanged.
- An error or a warning shows a provider's message instead of its raw JSON, such as Cloudflare's `errors[].message`: doctor now says `Could not check the release catalogs: 401 Authentication error`.
- `secrets put --kind android-keystore` without a terminal refuses once, listing all it needs: `--key-alias` and the password variables that aren't set.
- A table wider than a line shows each row as its own `label  value` lines.
- An unexpected failure in `deploy`, `patch`, or `fingerprint` prints its message as an error. `DEBUG=1` adds the stack.
