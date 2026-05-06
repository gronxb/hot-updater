---
"@hot-updater/cli-tools": patch
"@hot-updater/plugin-core": patch
"@hot-updater/console": patch
---

refactor(cli-tools): extract `promoteBundle` from `@hot-updater/console` so it can be reused by the CLI

`promoteBundle` and `createCopiedBundleArchive` move from `@hot-updater/console`'s server-only `lib/server/promoteBundle.ts` into `@hot-updater/cli-tools`. The console's RPC handler now imports from `@hot-updater/cli-tools`. UUIDv7 helpers (`createUUIDv7`, `extractTimestampFromUUIDv7`, `createUUIDv7WithSameTimestamp`) move to `@hot-updater/plugin-core` since they are generic primitives, not console-specific.

Pure refactor — no behavior change. Existing test coverage moves with the function. This unblocks an upcoming `hot-updater promote` CLI command that calls the same implementation as the console UI.
