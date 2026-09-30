---
"hot-updater": patch
---

`hot-updater db generate --sql` writes core's tables and those of the server's plugins, which it finds as plugin commands find theirs: in the server config the first argument names, in `hotUpdater.plugins.ts`, or in a default server config. It names the file it read them from; without one, it says so and writes core's tables only. The agent scaffold's Firestore `database.config.ts` exports `migrate(plugins)`, which `provision-client-credential.mjs` runs with the plugins `hotUpdater.plugins.ts` lists.
