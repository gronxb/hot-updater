---
"@hot-updater/plugin-core": minor
"hot-updater": minor
---

Allow build plugins to explicitly preserve opaque output files through archive
creation. Preserve file names and bytes, including runtime maps and paired
bundle/Hermes-looking names, while rejecting reserved manifest collisions and
unsafe paths before hashing or upload. Retain existing RN handling when no file
policy is selected. Preserve the previous CLI archive if a subsequent compiler
run fails before compression begins.

Allow a build plugin to explicitly own native signing-key discovery. Lynx uses
its application-supplied native key resolver; missing or mismatched keys reject
signed deployment even when unrelated native files contain React Native keys.
Existing React Native and Expo discovery behavior remains unchanged.
