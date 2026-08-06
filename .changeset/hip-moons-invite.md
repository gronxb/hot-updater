---
"hot-updater": patch
---

fix: read the iOS app version from Info.plist before project.pbxproj

`getNativeAppVersion("ios")` tried the `xcodeproj` parser first and only fell back
to `info-plist`. Parsing project.pbxproj is synchronous, so on a large project it
blocks the event loop for the whole parse, and `deploy` does this after the bundle
has already been uploaded, just to fill in `metadata.app_version`. On a 12.5MB
pbxproj that was ~5 minutes locally and ~16 minutes on CI.

Info.plist is read first now. `CFBundleShortVersionString` is also closer to what
the built app actually reports than `MARKETING_VERSION` (#84). The xcodeproj parser
is still there as a fallback when Info.plist has no version.
