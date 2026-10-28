---
"hot-updater": patch
"@hot-updater/cli-tools": patch
"@hot-updater/plugin-core": patch
---

A configured `secrets` adapter is the only store: the CLI no longer reads `~/.hot-updater/secrets/` under it or writes there for it, so a teammate with the config and store access sees what you see. An adapter without `set` makes `secrets put`, `secrets issue`, `apple login`, `google-play login`, a build's sign-in and `keys generate --secret` refuse in one line, before any sign-in. An issued key must read back exactly through the adapter, or it is revoked; the run uses it from memory. When the environment overrides a key the adapter lacks, `apple login` and `google-play login` add an `Adapter` row. `hot-updater doctor` lists each `secret:` reference and whether the adapter, the environment, or nothing holds it, with matching `--json` fields.
