---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/console": minor
"@hot-updater/protocol": minor
"@hot-updater/apple-helper": minor
"hot-updater": minor
"@hot-updater/test-utils": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
---

Add the iOS device registry: the iPhones and iPads a team asks to install ad hoc builds on, kept in the server's database (new core tables `ios_devices`, and `ios_device_account`, the one Apple account the registry belongs to), as requested, approved, or registered with Apple.

- Console: **Native builds** gets an **iOS devices** view, beside Builds, with no new menu. A tester opens it on an iPhone, names it, and installs a profile that reads its UDID; the iPhone is listed as requested. On a build's page, an iPhone the `.ipa` doesn't list gets **Request access** instead of a command to copy, and an ad hoc build's page lists the devices its `.ipa` includes, by registry name. The profile link is a short-lived capability signed with `BETTER_AUTH_SECRET`, and Request access takes the UDID only from a receipt the profile's answer signed for the same signed-in person. Approvers approve, rename, and remove devices: the emails in the new `console.deviceApprovers` of `defineConsoleConfig`, or anyone on the local Console. Without `deviceApprovers`, a hosted Console approves nothing. The Console still holds no Apple key.
- CLI: an ad hoc `native-build ios` registers the approved devices with the Apple account of the scheme's `signing.ascApiKey` before it archives, one at a time, recording each answer. When the exported `.ipa` still lacks an approved device Apple has enabled, it deletes this app's saved Xcode-managed ad hoc profiles (matched by team and application identifier) and exports once more; a device still missing fails the build before it is tracked. A scheme with no key, with manual signing, or signing with another Apple account than the registry's registers nothing and says so. `--json` reports `devices`. `native-build devices add` picks from the requested devices at a terminal without `--udid`, and records what it registers; `devices list` shows the registry beside the Apple account; the new `devices rename` renames a device in both, and `devices remove` deletes it from the registry and, once confirmed or with `--yes`, disables it at Apple.
- The per-build profile routes under `/_hot-updater/native-builds/<id>/device*` are replaced by `/_hot-updater/devices/device.mobileconfig` and `device-response`. The shell command that removed saved profiles is gone: the build handles it.
- One Apple account per registry: before a build sends Apple its first device, it claims the registry for its key's issuer in `ios_device_account`, whose single key makes the claim atomic on every store; a build of another account sends Apple nothing, and an approved device another account registered before is never sent by a different account.
- Server: core gains `claimIosDeviceAccount`, `listIosDevices`, `findIosDevice`, `requestIosDevice`, `approveIosDevice`, `renameIosDevice`, `recordIosDeviceOutcome`, `markIosDevicesInBuild`, and `deleteIosDevice`, with admin routes under `/ios-devices` that `standaloneRepository` uses. No client route changes.
- Protocol: `readIpaInstallInfo` reports the `.ipa`'s `teamId`, and `readProvisioningProfile` reads a saved profile.

The table is part of the 1.2.0 migration. A database a 1.2 prerelease already migrated needs it created by hand, before this version is deployed over it: until then, an ad hoc build and the Console's iOS devices view fail to read the registry. Upgrade in this order: create the table, deploy the server, deploy the Console, then upgrade the CLI.

- D1 or SQLite:

  ```sql
  CREATE TABLE IF NOT EXISTS "ios_devices" ("id" TEXT NOT NULL, "udid" TEXT NOT NULL, "name" TEXT NOT NULL, "status" TEXT NOT NULL, "requested_by" TEXT, "created_at_ms" INTEGER NOT NULL, "approved_by" TEXT, "approved_at_ms" INTEGER, "registered_at_ms" INTEGER, "apple_issuer_id" TEXT, "apple_error" TEXT, "build_id" TEXT, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));
  CREATE INDEX IF NOT EXISTS "ios_devices_byStatus" ON "ios_devices" ("status", "id");
  CREATE UNIQUE INDEX IF NOT EXISTS "ios_devices_udid" ON "ios_devices" ("udid");
  CREATE TABLE IF NOT EXISTS "ios_device_account" ("id" TEXT NOT NULL, "apple_issuer_id" TEXT NOT NULL, "claimed_at_ms" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));
  ```

- Supabase: the `hot_updater_v1_ios_devices` table with its two indexes and the `hot_updater_v1_ios_device_account` table, each with `ENABLE ROW LEVEL SECURITY`, as in `0002_hot-updater_1.2.0.sql`, then that file's `CREATE OR REPLACE FUNCTION public.hot_updater_v1_apply`, whose table allowlist names both.
- PostgreSQL (Vercel, Neon, or your own): the same as Supabase without the `hot_updater_v1_` prefix, row level security, or the function, as in `@hot-updater/postgres`'s `sql/bundles.sql`.
- MySQL: the `ios_devices` table with its two indexes and the `ios_device_account` table, as `hot-updater db generate --sql mysql` prints them.
- MongoDB: `hot-updater db migrate` on the server, or these, which are the adapter's own index definitions:

  ```js
  db.ios_devices.createIndexes([
    { name: "byStatus", key: { status: 1, id: 1 } },
    { name: "all", key: { id: 1 } },
    { name: "udid", key: { udid: 1 }, unique: true },
  ]);
  db.ios_device_account.createIndexes([{ name: "all", key: { id: 1 } }]);
  ```
- Prisma or Drizzle: run `npx hot-updater db generate <server file>`, then the migration the ORM writes from it.

DynamoDB, Firestore, and Cosmos DB need nothing. Nor does `standaloneRepository`: its server's database takes the table. An AWS deployment re-runs `hot-updater init` only to keep its Lambda role's DynamoDB policy listing every core table; the Lambda never reads this one.
