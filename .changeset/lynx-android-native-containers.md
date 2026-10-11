---
"@hot-updater/lynx": patch
"@hot-updater/lynx-sparkling": patch
"@hot-updater/lynx-build": patch
---

Add an Android host for native LynxView containers. Track dynamic mount identity,
serialize page admission, and recreate the full managed generation after native
runtime teardown while retaining application container placement.
Keep the existing Fresco compatibility adaptation in the Lynx SDK so both native
hosts share its service, and include that implementation in native fingerprints.
