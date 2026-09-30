---
"@hot-updater/server": minor
"hot-updater": minor
---

Server plugins add their own `hot-updater` commands through a `cli` field on `definePlugin`. A command runs `run` with the plugin's API over a database the CLI opens itself; with a `standaloneRepository` config, it asks for the server config that exports `hotUpdater`. The CLI looks for plugin commands only when it has no core command of that name: in a server config the command line names, then `hotUpdater.plugins.ts` over the database in `hot-updater.config.ts`, then `hot-updater.config.ts`, `src/hotUpdater.ts`, or `src/db.ts`. `hot-updater --help` and the unknown-command error list them under **Plugin commands**, marked with their plugin's id.

`hot-updater api-key create|list|revoke` now comes from `apiKeys()`, with the same arguments and options, and also runs in managed projects through `hotUpdater.plugins.ts`. `@hot-updater/server/db` exports `serverPluginsOf` and `pluginCommandsOf` for tooling.
