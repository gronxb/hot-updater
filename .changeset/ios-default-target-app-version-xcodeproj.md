---
"hot-updater": patch
---

Read the default iOS target app version from `project.pbxproj` when `Info.plist` holds an unresolved build setting. The React Native template ships `CFBundleShortVersionString` as `$(MARKETING_VERSION)`, which the plist parser cannot resolve, so `getDefaultTargetAppVersion` returned `null` for most iOS projects: `deploy -i` prefilled the "Target app version" prompt with `1.0.0` instead of the real version, and non-interactive `deploy` without `-t` failed outright. `getNativeAppVersion` already falls back to the same parser; this aligns the two.
