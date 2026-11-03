---
"hot-updater": patch
"@hot-updater/console": patch
---

Fix findings from the 1.2.0-rc.13 QA.

- `native-build mark --json` prints `{ "id", "marked": false, "reason" }` (`"cleared"` with `--clear`) when it refuses the build, with `reason` `not_found` for an ID no build has or `sandbox_channel`, and still exits with code 1. It printed nothing on stdout.
- `bundle update`, `enable`, `disable`, `delete` and `promote` end a refusal, such as an ID no bundle has or deleting an enabled bundle, with its message and no stack trace, and under `--json` print `{ "id", "updated" | "deleted": false, "reason" }` (`promote` has no `--json`). Given an Artifact ID, such as the one `native-build mark` and `patch -b` print, they name the bundle ID to use.
- `deploy` no longer warns "Partial update skipped" for a patch base whose Hermes bundle is unchanged: no patch is needed, and the step reports `Skipped (Hermes bundle unchanged)`.
- `doctor` keeps Google Play check details in one column, and puts the detail of a long application ID on the line under it.
- The Console's native build page names the build new deploys patch from by app version and build number, such as `iOS 1.7.0 (66)`, as the CLI does.
