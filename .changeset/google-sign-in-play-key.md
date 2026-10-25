---
"hot-updater": minor
"@hot-updater/android-helper": minor
---

Sign in with Google to issue the Play service account key. `build:android --upload play-internal` that finds no `play-service-account` in the config's `secrets` adapter opens Google's sign-in page in a terminal, checks that the account administers the Play Console developer account and that Google Play has the app, then creates the service account `hot-updater-play` in a Google Cloud project you pick or a new one, gives it release access to the app in Play Console, creates its JSON key, stores it through the adapter, or in an owner-only file when the adapter can't store it, and continues; `hot-updater secrets put play-service-account --kind play-service-account` without `--service-account` does the same ahead of time. Builds without a terminal use the stored key, and refuse with that command when there is none. Only the key is kept: the sign-in's access token is revoked, and a key the adapter surely did not store is deleted again. `HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID` and `HOT_UPDATER_GOOGLE_OAUTH_CLIENT_SECRET` sign in with an OAuth client of your own.
