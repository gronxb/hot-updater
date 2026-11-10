---
"@hot-updater/cli-tools": patch
"@hot-updater/test-utils": patch
"@hot-updater/console": patch
---

Bundle tar 7.5.22 and workspace-tools 0.42.3 (js-yaml 4.3.2), leave out workspace-tools' lockfile parsers and their minimatch 3.0.4 copy, and regenerate the `inlinedDependencies` field on every build so it lists what dist bundles.
