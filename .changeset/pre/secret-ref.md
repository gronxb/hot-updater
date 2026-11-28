---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/plugin-core": minor
"@hot-updater/aws": minor
"@hot-updater/azure": minor
"@hot-updater/cloudflare": minor
"@hot-updater/postgres": minor
"@hot-updater/standalone": minor
"@hot-updater/supabase": minor
"@hot-updater/vercel": minor
---

`secret("<name>")` from `hot-updater` names every credential in `hot-updater.config.ts`. It replaces the `"secret:<name>"` strings and `secretEnv([...])` of earlier 1.2 RCs, so configs written for those RCs break: rerun `init` for a managed config, or edit it as below.

```ts
import { defineConfig, secret } from "hot-updater";

export default defineConfig({
  storage: r2Storage({
    bucketName: "bundles",
    accountId: "…",
    credentials: {
      accessKeyId: secret("HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID"),
      secretAccessKey: secret("HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    },
  }),
  database: d1Database({
    databaseId: "…",
    accountId: "…",
    cloudflareApiToken: secret("HOT_UPDATER_CLOUDFLARE_API_TOKEN"),
  }),
  signing: { enabled: true, privateKey: secret("bundle-signing-key") },
  nativeBuild: {
    android: { release: { signing: { keystore: secret("release-keystore") } } },
    ios: { release: { signing: { ascApiKey: secret("asc-api-key") } } },
  },
});
```

- `secret()` returns a function an adapter calls on first use, so loading the config reads no secret. Called, it reads the environment or `.env.hotupdater` first, then the config's `secrets` adapter: one call reads every name of the config the environment doesn't set. With `localSecrets()`, an adapter credential must be set in the environment. Values are masked, and reserved names, such as `NODE_OPTIONS`, are refused.
- `signing.privateKey`, `signing.keystore`, and `signing.ascApiKey` take only `secret()`: a string is a type error, and the CLI refuses it in one line.
- Storage and database adapters take each credential as a string or a function (plugin-core's `Lazy<T>`), so servers keep passing their own environment's values. `s3Storage`, `dynamoDB`, and `r2Storage` also take access keys whose fields are lazy, and the header values of `standaloneRepository` and `standaloneStorage` may be lazy.
- `init` writes `secret()` inline and moves an earlier RC config's `secretEnv` helpers to it. `doctor` and `secrets import` find the names in the adapters' `secret()`s.
- `secrets put bundle-signing-key <key.pem>` moves an existing RSA key (PKCS#1 or PKCS#8, 2048 bits or more) into the secrets store as PKCS#8, reads it back, and prints its public key's SHA-256 fingerprint. A `privateKeyPath` key moves this way without a new trust anchor.
