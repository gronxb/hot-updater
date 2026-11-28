---
"@hot-updater/react-native": patch
"@hot-updater/cli-tools": patch
---

Fix two Windows failures: the Android fingerprint Gradle task no longer passes node an inline script with double quotes, which `ProcessBuilder` broke (#1853), and the CLI finds `AndroidManifest.xml` with a `/` glob pattern, so `keys export-public`, `channel set`, and `doctor` see Android manifests again (#1854).
