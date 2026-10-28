---
"hot-updater": patch
"@hot-updater/android-helper": patch
"@hot-updater/cli-tools": patch
---

`google-play login` signs in to Google with the gcloud CLI, running `gcloud auth login` when no account is active, and needs no Google OAuth client of your own (`HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` are gone) and no Play Console developer account ID. The package name is filled in from the config's `nativeBuild.android` schemes (a choice when they declare several), as `native-build android --submit play-internal` does. The service account goes in the Google Cloud project "Hot Updater Play" an earlier run created, or a new one, without asking; only when Google refuses to create a project does it ask for one of the account's projects. After creating the key, it opens Play Console's invite page for the service account and waits, up to 10 minutes, until the key can reach the app; when it never does, it deletes the key and says to invite the service account and run `npx hot-updater google-play login` again.
