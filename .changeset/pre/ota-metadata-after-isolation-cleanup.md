---
"@hot-updater/react-native": patch
---

Keep an OTA from getting stuck after an app goes back to an earlier build.

When a build of another fingerprint, channel, or version is installed, the SDK deletes the downloaded bundles. It left `metadata.json` naming them. If that build wrote no metadata of its own, because it had no network or its channel was empty, reinstalling the original build brought the old selection back: the app ran its built-in JavaScript, `getBundleId()` reported the deleted OTA, and `checkForUpdate` stopped offering it until a newer release was published.

- The cleanup now replaces the metadata before it deletes the bundles, so a crash between the two leaves only files nothing names. A pending OTA caught by the cleanup is no longer recorded as crashed.
- A launch now forgets a verified bundle whose files are gone, so a device already left in this state reports what it runs and installs the OTA again.
