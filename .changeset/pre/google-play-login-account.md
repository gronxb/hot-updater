---
"hot-updater": patch
"@hot-updater/android-helper": patch
---

`google-play login` asks which Google Account to use when gcloud already holds one: the accounts gcloud holds, the active one first, or "Sign in with another Google Account", which runs `gcloud auth login` and uses the account it adds. It reads the access token of the chosen account and leaves gcloud's active account as it was. The Play Console invite, and the refusal when the key never reaches the app, name the exact permission to grant: the app permission "Release apps to testing tracks", under App permissions rather than account-wide.
