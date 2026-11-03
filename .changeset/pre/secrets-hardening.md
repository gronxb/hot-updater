---
"hot-updater": patch
"@hot-updater/cli-tools": patch
"@hot-updater/firebase": patch
---

Harden how credentials are stored, replaced, and printed.

- `secrets put` keeps a name that already holds another value, such as the only copy of an upload keystore or the signing key shipped apps verify bundles with, and asks you to back it up and run the same command with `--replace`. A keystore is refused before its passwords are asked. Putting the same value again stores nothing and succeeds.
- Google Cloud `secretManager().set` keeps the version it replaced as the previous one, as AWS keeps `AWSPREVIOUS`, and destroys only older versions it added. Each secret holds at most two active versions.
- `secrets pull` refuses a file git tracks before it reads the store, naming `git rm --cached`. It used to write the file and then warn.
- A failed native build's summary masks credentials before it cuts long lines, so a cut no longer leaves part of a value unmasked.
- A native build's key no longer records the hash of an environment variable named like `STORE_PASS`, `KEY_PASS`, or `*_PASSPHRASE`.
- `infisical()` doesn't print a rejected `siteUrl` that has a query or fragment, which may hold a token.
- The `native-build`, `preview`, and `release` actions keep a failed build's log artifact for one day.
