---
"hot-updater": patch
"@hot-updater/cli-tools": patch
---

Fix findings from the 1.2.0-rc.14 QA.

- `secrets put` with the value the store already holds stores nothing and prints `Secret already stored`, with `--replace` too. It wrote a new version of the same value, which on Google Cloud `secretManager()`, which keeps one previous version, pushed the real previous value out. A keystore whose passwords a terminal asks for prints `Upload key already stored` the same way.
- `secrets import`, and init over a team store, write no new version of a value the adapter already holds.
- `bundle delete` of an enabled bundle prints `Bundle <id> is enabled. Disable it first:` and the `npx hot-updater bundle disable <id>` command on its own line. It printed core's sentence, wrapped, with no command. `--json` keeps its `"reason": "enabled_release"`.
- A bundle command whose `--expected-revision` no longer matches names the bundle by its short ID and the `npx hot-updater bundle show <id>` command to see what changed.
