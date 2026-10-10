---
"@hot-updater/plugin-core": patch
"@hot-updater/react-native": patch
---

Two messages now name the actual problem.

- The schema fence tells a database that hasn't been migrated, such as a new one or one whose tables `drizzle-kit push` or `prisma db push` just created, to run `hot-updater db migrate`. It asks for a new empty database only when `hot-updater db migrate` refuses a database from before the storage engine.
- `@hot-updater/react-native` reports a 404 from the artifact endpoint as the server's HTTP 404, the same as a catalog request, instead of "Server does not support artifact protocol 1". Responses that aren't artifact protocol 1 still fail with that message.
