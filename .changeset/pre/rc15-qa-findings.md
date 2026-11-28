---
"hot-updater": patch
"@hot-updater/cli-tools": patch
---

Fix findings from the 1.2.0-rc.15 QA.

- `secrets import` names what it stored apart from what the store already held: a second import of the same file prints `Already stored in the <adapter> secrets adapter` and writes nothing, where it printed `Stored in`.
- `secrets import` no longer overwrites another value the store holds, which may be its only copy. As `secrets put` does, it writes nothing, names each such variable, and asks to back them up and rerun with `--replace`. `init` with a team store keeps both values the same way and warns with `npx hot-updater secrets import --replace`.
- `doctor --server-base-url` requires the release whose server schema and API this CLI needs, not the CLI's own version. A release candidate's CLI passed only against a server of the same release candidate, so a CLI-only release asked for a redeploy, quoting the 1.2.0 schema note. A prerelease server of the required release now passes a prerelease CLI of it; a stable CLI still requires a stable server.
