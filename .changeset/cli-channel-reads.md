---
"hot-updater": patch
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/standalone": patch
"@hot-updater/console": patch
"@hot-updater/test-utils": patch
---

fix(cli): channel lookups, `bundle list`, and `doctor` no longer read whole tables.

- **Channels by ID.** `bundle list`, `bundle show`, `bundle promote`, `native-build delete`, and `insights --bundle` used to read every channel to name the ones they show. They now read only those channels, in one batch read. `bundle list --channel` finds the channel by its name. The preview and release actions run `bundle list -c <channel> -p <platform> --limit 1` after every deploy, and that now reads 2 rows, however many preview channels a project keeps. Core adds `getChannels(ids)`, and `listChannels` takes an optional page.
- **Admin `GET /channels`** also takes `ids=<channel id>,...` (1 to 100) and `limit`/`cursor` pages by name. Without them it answers every channel, as before. A CLI on this release still works with an older self-hosted server, which ignores the new parameters.
- **`bundle list --platform` without `--channel`, and `--target-app-version`,** read at most 5 pages of 100 bundles. When nothing matched by then, the list prints how many bundles it scanned and a `--cursor` to continue, or you can narrow it with `--channel`. With `--json`, that line goes to stderr.
- **`hot-updater doctor`** checks the scopes in the catalog index, and finds every scope with releases but no catalog row by seeking from one scope to the next: one limit-1 read per scope. It no longer reads every release, and its reads grow with scopes, not with releases or channels. Core adds `listReleaseScopeKeys`, and the admin API `GET /release-scopes` (`limit` up to 100, `cursor`). Against a server without that route, doctor's catalog check warns that it could not run and names the upgrade.
- **Core schema:** `releases` declares a `scopes` index ordered by scope key. SQL and MongoDB read it through the existing `byScope` index, so their schemas don't change. On DynamoDB, Firestore, and Cosmos DB it adds one index item per release, and `db migrate` writes those items for the releases already stored.
- **Admin `POST /ios-devices/in-build`** takes at most 100 IDs a request, and answers 400 for more. The standalone client sends devices in requests of 100. `POST /bundles/delete` stays uncapped: a released `doctor --fix` sends every unreferenced artifact in one request.
