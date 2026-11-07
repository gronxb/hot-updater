---
"hot-updater": patch
"@hot-updater/android-helper": patch
"@hot-updater/cli-tools": patch
---

Google Play is set up with `secrets put`, and checked before a build. `hot-updater google-play login` and its gcloud flow are removed, along with `secrets issue play-service-account`. Store the service account's JSON key with `secrets put play-service-account <key.json>`, which checks that the file is a service account key and names `google-services.json` when you pick that one by mistake. Store the app's upload keystore with `secrets put android-keystore <file>`, which asks for its passwords at a terminal and checks them with keytool. `secrets put` takes the file as its second argument and defaults the kind to the name, and every value it stores is read back exactly. `native-build android --submit play-internal` and `google-play upload` check the key, the keystore, and Play access (an edit opened and deleted) before the prebuild. They list every unmet item at once, with the command, the Play Console invite, or the first `.aab` upload that fixes it. `hot-updater doctor` adds a Google Play row with the same access check for each Android package. `secrets issue android-keystore` now says its new key fits only an app with no `.aab` on Google Play yet. The native build guide has a new "Set up Google Play" section.
