---
"@hot-updater/server": patch
"@hot-updater/js": patch
"@hot-updater/firebase": patch
"@hot-updater/cloudflare": patch
"@hot-updater/postgres": patch
---

fix: propagate shouldForceUpdate from intermediate OTA bundles

When a forced update (bundle 2) exists between the user's current bundle and
a newer non-forced update (bundle 3), the forced flag was silently lost because
only the latest bundle's `shouldForceUpdate` was returned.

Now, if ANY enabled bundle between the user's current bundleId and the update
candidate has `should_force_update = true`, the response's `shouldForceUpdate`
is set to `true`. This ensures users cannot skip critical forced updates.

Fixes #572
