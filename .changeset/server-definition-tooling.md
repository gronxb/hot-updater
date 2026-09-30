---
"@hot-updater/server": minor
---

Tooling reads a server definition's database, storage, and plugins through `serverDefinitionOf(hotUpdater)` from `@hot-updater/server/db`. A server checks that its storage serves downloads (`get` and `getDownloadUrl`) where it first reads `hotUpdater.handlers`, so the CLI and the console can load a definition whose storage only uploads. The admin `/version` also lists `clientPlugins`, the client plugins an app adds for the server's plugins, which `hot-updater doctor` checks.
