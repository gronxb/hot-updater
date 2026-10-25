---
"hot-updater": patch
---

The iOS app version no longer records an unresolved `${MARKETING_VERSION}` from `Info.plist` or `project.pbxproj`. Xcode substitutes `${NAME}` as well as `$(NAME)`, so a `${NAME}` placeholder is now skipped and the next source is used, like `$(NAME)`.
