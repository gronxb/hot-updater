---
"@hot-updater/cli-tools": patch
"@hot-updater/vercel": patch
"@hot-updater/azure": patch
"@hot-updater/firebase": patch
"hot-updater": patch
---

fix: managed upgrades from 1.0.x and 1.1.x to 1.2.0.

- **Inputs from the environment.** Vercel's and Azure's init read an input the environment sets, as init's preflight and every other provider do, so a database URL set for the run, as the 1.2.0 upgrade guide says, is used instead of failing with `must be a postgres:// or postgresql:// URL`. Every provider's init also reuses a `HOT_UPDATER_API_KEY` the environment sets.
- **Vercel public Blob store.** Init of 1.0.2 and 1.0.3 could create a public store, which init now replaces instead of failing with a 409: it copies every object to the private store `<store>-private`, migrates the database, then, while bundle writes wait, copies what was published meanwhile and points the database's storage URIs at it, disconnects the public store from the project, and redeploys the Function. It refuses before any change without the public store's token, continues where an interrupted run stopped, and moves any public store the database still names, such as a bundle a deploy already under way wrote after the move. Doctor reports the saved `HOT_UPDATER_VERCEL_BLOB_ACCESS=public` and names init.
- **Vercel config.** Init's rewrite of a 1.0.2 or 1.0.3 config drops `vercelBlobStorage`'s removed `access` option, so the config type-checks.
- **Google credentials.** Firebase init stops before any change with what is wrong when Google credentials don't load, such as the 1.0.0 placeholder `GOOGLE_APPLICATION_CREDENTIALS=your-credentials.json`. `firebaseDatabase` with a `credential` loads it before its first Firestore call, so doctor reports the failed read instead of ending with a stack trace.
