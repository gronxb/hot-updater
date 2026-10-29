---
"hot-updater": patch
"@hot-updater/cli-tools": patch
"@hot-updater/aws": patch
"@hot-updater/azure": patch
"@hot-updater/firebase": patch
---

Catch a wrong upload-key password before it is stored, and keep secrets errors short.

- `secrets put android-keystore` checks that the key password unlocks the key by signing an empty file with the JDK's `jarsigner`, as Gradle signs, before anything is stored. keytool's certificate request reads a PKCS12 key with the store password whatever the key password is, so a PKCS12 keystore stored with another key password, as EAS records it, used to fail the build only at its final signing step ("Given final block not properly padded"). The refusal reads `The key password doesn't unlock "<alias>".`, then `For PKCS12 keystores, the key password is the store password.` when the store password unlocks the key. At a terminal the CLI then offers to store the store password as the key password; in CI it stops, storing nothing.
- `--key-alias`, which stored a keystore without checking it, now runs the same check, so it needs a JDK on the machine, as Android builds do.
- `secrets issue android-keystore` names a stored keystore whose passwords don't open its key, and `hot-updater doctor` marks such a keystore in its Secrets block (`in the adapter, doesn't open`), with the reason and the command that stores it again. Without a JDK, doctor leaves it unchecked.
- A `signing` secret the store doesn't hold points at importing the existing key, `npx hot-updater secrets put bundle-signing-key <key.pem>`, and at checking the name and access, never at `secrets issue`, whose new key every shipped app rejects. `secrets put android-keystore` without a file offers `secrets issue android-keystore` only for an app with no `.aab` on Play yet.
- `infisical()`, `localSecrets()`, `secret()`, `secretsManager()`, `keyVault()`, and `secretManager()` errors print a line per idea, the reason first and the fix last, at most 76 columns: a provider's own message is wrapped or shortened on its own lines, a secret's full name gets a `Secret:` line, and long commands break with `\`.
- `infisical()` names its instance's URL, as an `Instance:` line, only when `siteUrl`, `INFISICAL_DOMAIN`, or `INFISICAL_API_URL` sets it; with none set, messages say `Infisical`.
