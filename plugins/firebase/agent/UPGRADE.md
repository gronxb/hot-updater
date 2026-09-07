# Firebase upgrade

Read COMMON.md and UPGRADE-NOTES.md. Inspect project, hot-updater-v1 region/URL,
runtime identity, default Storage bucket, Firestore v1 namespace and indexes,
and /version. Preserve the project, existing v0 collections/functions, v1 data,
client API keys and any CDN settings.

Compare the new Functions runtime/dependencies and Firestore indexes. Merge
required indexes with unrelated existing indexes and wait for readiness. The
current generation-1 baseline needs no manual data-copy migration; inspect its
adapter-version marker and do not overwrite a partially incompatible namespace.
Deploy hot-updater-v1 in the existing region and verify its endpoint, runtime
identity and version. A failed Functions deploy should be retried after checking
its current status; do not recreate the project or discard completed indexes.

Use the direct Function URL. Do not replace Firebase Hosting configuration or
the default Hosting site to perform this upgrade. For v0-to-v1 migration, reuse
the project only with the separate v1 namespace/function and a new native build,
as specified in UPGRADE-NOTES.md.
