---
"hot-updater": patch
---

fix(cli): `deploy` falls back to the auto-detected target app version in non-interactive mode

Previously, running `hot-updater deploy` without `-t` and without `-i` errored with
"Target app version not found", even though `getDefaultTargetAppVersion` had already
extracted the version from the binary's native files (Info.plist for iOS, build.gradle
for Android) for use as the interactive prompt's placeholder. CI deploys had to
either pass `-t` explicitly or scrape the version out of package.json.

Now the resolution order is: explicit `-t` → interactive prompt (with the auto-detected
value as placeholder) → auto-detected default → clear error if the native config is
unreadable. Existing `-t` and `-i` invocations are unchanged.
