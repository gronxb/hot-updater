---
"@hot-updater/react-native": patch
---

Escape public key newlines in the Expo Android config plugin so fingerprint and channel commands preserve bundle signature verification. Rerun `expo prebuild` after upgrading to regenerate existing Android manifests.
