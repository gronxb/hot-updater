---
"hot-updater": patch
"@hot-updater/apple-helper": patch
"@hot-updater/cli-tools": patch
---

rc.6 QA fixes. A CI iOS build revokes only the signing certificates Xcode created in its keychain, never the Apple CA intermediates imported beside them, and a certificate it can't revoke is named on one line with its serial on the next, then the page to revoke it. When Apple's Program License Agreement isn't accepted, the build failure, TestFlight uploads, the certificate revocation, and key issuing say the Account Holder must accept it at developer.apple.com/account. `secrets import` takes the env file to read, `.env.hotupdater` by default, reads only that file, and lists the names it stored one per line. A secrets adapter that can't be read names the secret and the adapter above its own error. A command that reaches the database or storage names each variable hot-updater.config asserts as `process.env.<name>!` and read while it was unset, before a provider's SDK runs. `secrets issue asc-api-key` and `apple login` name the team the key was issued in.
