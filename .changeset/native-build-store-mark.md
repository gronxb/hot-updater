---
"hot-updater": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/console": minor
"@hot-updater/cloudflare": minor
"@hot-updater/supabase": minor
"@hot-updater/postgres": minor
"@hot-updater/test-utils": minor
---

Mark the build the store sells, so a fresh install's first OTA stays a patch however many builds follow it.

- `hot-updater native-build mark <id> [--clear]` marks a build as its scope's store build, replacing the scope's mark in one write, and patches the newest OTA already serving that scope. A build on a `sandbox-*` channel can't be marked. Run it again and it changes nothing. The Native builds page in the Console has the same action, and shows the `hot-updater patch` command when the newest OTA has no patch from the marked build.
- `hot-updater deploy` patches from exactly one built-in bundle of its scope: the store build, or with no mark the most recently registered build, in one more indexed read. It prints which one, and whether it was marked. A build made after the deployed bundle is passed over for an older one instead of leaving the deploy with no built-in base.
- A target range such as `1.x.x`, and a default target such as `1.7.x` for a project at `1.7`, use the project's app version for that lookup when the range holds it. They found no build before.
- `native_builds` has a nullable `store_build` and a unique `byStoreBuild` index, in v1.2's existing `0002` migrations. `schema.core` stays `1.2.0`, so a database a v1.2 prerelease migrated needs the column and the index by hand.
