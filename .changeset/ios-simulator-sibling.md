---
"hot-updater": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/console": minor
"@hot-updater/apple-helper": minor
"@hot-updater/cloudflare": minor
"@hot-updater/supabase": minor
"@hot-updater/postgres": minor
---

A pull request preview can offer an iPhone build and a Simulator build of the same native code, and the Console links them.

**Preview action.** `ios-scheme` takes several schemes, comma-separated, such as `sandbox, sandboxSimulator`.

- **One run, one bundle, one comment.**
  - Each scheme's build is found, or built, before the platform's single bundle deploys.
  - The schemes must build the same native code. Schemes with different fingerprints or app versions fail the platform before anything deploys.
  - A scheme that fails doesn't stop the others. The comment names it, and `ios-build-log` lists every failed scheme's log.
- **Outputs.** With several schemes, each `previews` entry carries its `scheme`, and the platform's other outputs are its first scheme's. `ios-submit` takes one `ios-scheme`.
- **A single scheme** works exactly as before. The one change is a sandbox Simulator scheme: its comment and `ios-install-url` give `npx hot-updater native-build install <id> --open <channel>` instead of a QR code a Simulator can't scan.

**CLI.** `hot-updater native-build install <id> --open <channel>` installs a sandbox Simulator build on the selected Simulator and opens the channel's latest bundle through its preview link, as the QR code does on a phone. It refuses a normal build, which opens the channel it embeds, and an app-version build, whose link has no fingerprint.

**`native-build find --scheme`** finds the newest build of the scheme's own artifact kind. A newer Simulator `.app` of the same channel and fingerprint no longer hides the `.ipa`, or the reverse, so a preview reuses each one instead of building or downloading it again.

**Console.** The Install card of a sandbox build switches between **iPhone** and **Simulator**, a link to the newest build of the other target of the same native code, when there is one.

- An `.ipa` qualifies when it was exported for direct install, no store took it, and it isn't the store build. The same rule applies on both sides.
- The build page reads it with one more query. The Native builds list and its pages are unchanged.

**Core.**

- `findNativeBuild(scope, { artifactKind })` reads a new `native_builds_byScopeKind (scope_key, artifact_kind, id)` index. When the index has no row, it falls back to the scope's newest row and keeps it only if its kind matches, so rows written before the index are still found.
- `findNativeBuildSibling(build)` is new, with the admin route `GET /native-builds/:id/sibling`.

If a 1.2.0 prerelease migrated your SQL database before this release, create the index once; the fallback works without it. This is safe to run again:

- Cloudflare D1, SQLite, PostgreSQL, Neon: `CREATE INDEX IF NOT EXISTS "native_builds_byScopeKind" ON "native_builds" ("scope_key", "artifact_kind", "id");`
- Supabase: `CREATE INDEX IF NOT EXISTS "hot_updater_v1_native_builds_byScopeKind" ON "hot_updater_v1_native_builds" ("scope_key", "artifact_kind", "id");`
- MySQL: run ``SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'native_builds' AND index_name = 'native_builds_byScopeKind';``. Only when it returns 0, run ``CREATE INDEX `native_builds_byScopeKind` ON `native_builds` (`scope_key`, `artifact_kind`, `id`);``.
- MongoDB, DynamoDB, Firestore, Cosmos DB: nothing to do.
