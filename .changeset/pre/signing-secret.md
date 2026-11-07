---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/plugin-core": minor
---

Bundle signing reads one secret, and the signing adapters are removed.

```ts
import { defineConfig, secret } from "hot-updater";

export default defineConfig({
  signing: secret("bundle-signing-key"),
});
```

- `signing: secret("bundle-signing-key")` is the shorthand of `{ enabled: true, privateKey: secret("bundle-signing-key") }`: the secret holds the RSA private key in PEM. 1.1's `{ enabled: true, privateKeyPath }` keeps working as it is, and `{ enabled: false }` turns signing off.
- `npx hot-updater secrets issue bundle-signing-key` creates an RSA 4096 key, stores it as PKCS#8 through the config's `secrets` adapter, reads it back, prints its public key's SHA-256 fingerprint, and adds the shorthand to a config without `signing`. It keeps a stored key unless `--replace`, since apps already shipped reject bundles signed with a new key, and without a terminal it creates one only in a team store. `keys generate` is removed; `keys export-public` and `keys remove` read the key through `signing`.
- Without `signing`, `deploy` warns once a run, and `doctor` shows the same warning row: `Bundles are unsigned.`, then `To sign them, run: npx hot-updater secrets issue bundle-signing-key`.
- `awsKmsSigning`, `googleCloudKmsSigning`, and `remoteSigning`, the `hot-updater/signing` entry, plugin-core's `BundleSigningAdapter` and its remote signing protocol, and the reserved `HOT_UPDATER_SIGNING_TOKEN` are removed, with the optional `@aws-sdk/client-kms` and `@google-cloud/kms` peers. A signing adapter, or any other `signing` value, is a type error, and `deploy` refuses it, before it connects or builds, rather than deploy unsigned bundles: `signing takes secret("bundle-signing-key").`, then `Store your key: npx hot-updater secrets put bundle-signing-key <key.pem>`. `doctor` shows it as an error row.
- `@hot-updater/cli-tools`: `prepareBundleSigning(signing, { cwd, secrets })` and `getBundleSigningPublicKey(signing, { cwd, secrets })` take the config's `signing` as it is; `readBundleSigningState(signing)` tells signing on, off, unsigned, and refused apart. `DEFAULT_SIGNING_KEY_SECRET` is `BUNDLE_SIGNING_KEY_SECRET`. `addSigningSecretToConfig(cwd, name)` adds the shorthand to `hot-updater.config.ts`.
