---
"hot-updater": patch
---

The iOS app version reader now treats `${MARKETING_VERSION}` in `Info.plist` or `project.pbxproj` as unresolved, like `$(MARKETING_VERSION)`. Xcode substitutes both forms. Before, such a project resolved no default target app version, so `deploy` without `-t` stopped, and interactive `deploy` prefilled `1.0.0`; it now reads the version from the next source.
