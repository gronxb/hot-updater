---
"@hot-updater/console": patch
"hot-updater": patch
---

fix(console,cli): show release IDs as bundle IDs and name artifacts as artifacts

A bundle ID is a release's ID, the one `getBundleId()` returns and `bundle show` takes. A few Console and CLI surfaces showed an artifact's ID as a bundle instead.

- Console: a native build's **Patches from this build** names each target by its label and release ID, and shows a target its scope no longer serves as "Artifact" with its ID. **Served now**'s Created column dates a release by the release, so a promoted release shows when it was promoted.
- Console: the Bundles list's artifact filter is `?artifactId=`; `?bundleId=` is no longer read. The manifest download moved to `/api/artifacts/:artifactId/download`.
- CLI: `native-build mark` names the OTA missing a patch by its label and release ID. Its `--json` `missingPatch` holds `releaseId`, `label`, `artifactId`, and `command`, in place of `bundleId`.
- CLI: `patch`, `deploy`, and `storage prune` call an artifact an artifact in their messages.
