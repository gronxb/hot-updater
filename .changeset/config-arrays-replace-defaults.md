---
"@hot-updater/cli-tools": patch
---

Arrays in `hot-updater.config` now replace the defaults instead of being merged into them index by index. `platform.ios.infoPlistPaths` and `platform.android.androidManifestPaths` could not narrow the files the CLI discovers: listing one Info.plist in a project with three only overwrote the first discovered path and kept the other two, so commands such as `fingerprint create` and `keys export-public` still wrote to app extensions and test targets, and a manifest listed explicitly could be written twice.
