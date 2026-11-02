---
"hot-updater": patch
---

Say when a TestFlight build is waiting on export compliance.

- After App Store Connect accepts an upload, `native-build ios --submit testflight` and `testflight` read the build's state once on any scheme. A build waiting on export compliance gets a warning with the app's TestFlight page, and the run still exits 0. A failed read warns and fails nothing.
- `--json` carries the state in `submission.store` for every TestFlight upload, not only a sandbox build's.
- `doctor` warns when a scheme can submit to TestFlight and `Info.plist` has no `ITSAppUsesNonExemptEncryption`. The CLI never answers export compliance or writes the key.
