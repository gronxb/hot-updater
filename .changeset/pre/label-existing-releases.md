---
"hot-updater": patch
---

fix(cli): label existing releases with `db migrate` on any deployment, name the D1 database in doctor's label schema repair, and show release labels in the preview comment

- `hot-updater db migrate` without a server file, in a project with neither `src/hotUpdater.*` nor `src/db.*`, labels the releases of the database `hot-updater.config.ts` names once its schema is current. It never migrates that database, whose server is deployed apart from the project: a pending schema stops it with doctor's next step, such as init's command or the agent infrastructure upgrade, since an older server answers 503 on a migrated database.
- With a server file, `db migrate` on a database without a migrator, such as Supabase's or a self-hosted server's through `standaloneRepository`, checks the schema, then labels the releases, instead of stopping before the label fill.
- Doctor's `RELEASE_LABELS_MISSING` and `RELEASE_CATALOGS_WITHOUT_LABELS` name `npx hot-updater db migrate`, which deploys nothing, instead of `hot-updater init`, which redeployed a server that an agent infrastructure scaffold keeps.
- Doctor's label schema repair names the D1 database from `HOT_UPDATER_CLOUDFLARE_D1_DATABASE_NAME`, and the Supabase project from `HOT_UPDATER_SUPABASE_PROJECT_ID`, when the environment's saved database is the configured one, instead of `<database-name>` and `<project-ref>`.
- The preview action's comment shows each bundle's label, `vN`, before its ID in the Builds table, and its `previews` output carries `bundleLabel`.
