---
"@hot-updater/firebase": patch
"hot-updater": patch
---

Support a named Firestore database. `firebaseDatabase` and `migrateFirebaseDatabase` take a `databaseId` option, which defaults to `(default)`. Firebase `hot-updater init` asks which database to use when the project has more than one, saves the choice as `HOT_UPDATER_FIREBASE_DATABASE_ID`, and uses it for the index deploy, the schema settings, the generated config, and the `hot-updater-v1` Function. The agent scaffold takes the database ID as a deployment input.
