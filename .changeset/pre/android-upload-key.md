---
"hot-updater": patch
"@hot-updater/android-helper": patch
"@hot-updater/cli-tools": patch
---

`secrets issue android-keystore` creates the Android upload key with the JDK's keytool and stores it through the secrets adapter, and `google-play login` sets it up after the Play service account: a new key, or the keystore you have.
