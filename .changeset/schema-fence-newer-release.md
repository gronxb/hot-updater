---
"hot-updater": patch
"@hot-updater/plugin-core": patch
---

fix(cli): name the upgrade when a newer release migrated the database

When a newer Hot Updater already migrated the database, the schema fence no longer says to run `hot-updater db migrate`, which refuses to move a schema back. It names the upgrade:

```
Hot Updater schema setting "schema.core" for kysely is "1.3.0"; expected "1.2.0". The database was migrated by Hot Updater 1.3.0: upgrade hot-updater and the @hot-updater packages to 1.3.0 or later.
```

Commands that stop at the fence, such as `deploy` and `bundle list`, print its message as one line on stderr, without a stack trace, and exit 1. An older or missing schema setting keeps its message, and the server still answers 503.
