---
"hot-updater": patch
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
---

fix(db): `hot-updater db migrate` no longer moves a database back to an older schema. If a newer Hot Updater (such as 1.2) already migrated the database, `db migrate` changes nothing and exits 1:

```
kysely: the database was migrated by Hot Updater 1.2.0 (schema.core "1.2.0", this CLI's "1.0.0"). Upgrade hot-updater to 1.2.0 or later; nothing was written.
```

Before, it rewrote the schema version, and every server of the newer release answered 503. Commands such as `deploy` now stop on such a database with one line that names the upgrade, instead of a stack trace and a `db migrate` hint.
