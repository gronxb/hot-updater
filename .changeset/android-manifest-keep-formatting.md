---
"hot-updater": patch
---

The CLI keeps an `AndroidManifest.xml` as it is when it writes Hot Updater's meta-data. `fingerprint create`, `keys export-public`, `channel set` and `keys remove` used to parse the manifest and build it again, which dropped every XML comment and reformatted the whole file, so one command left a diff across the app's manifest. The CLI now replaces the `android:value` of the matching `<meta-data>` under `<application>` in place, or adds the element as the last child indented like its siblings, and removing a key takes only its line. Comments, attribute layout, indentation, line endings and the order of elements stay as they were.
