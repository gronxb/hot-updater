# @hot-updater/better-auth

Connect a configured Better Auth instance to the Hot Updater server kernel.

```ts
import { betterAuthPlugin } from "@hot-updater/better-auth";

const plugin = betterAuthPlugin({ auth });
```

Session mode reads `auth.api.getSession({ headers })` and maps only `user.id`
to the kernel principal. It protects routes that are already declared
protected.

API-key mode calls `auth.api.verifyApiKey` and protects every route emitted by
`createHotUpdater`:

```ts
const plugin = betterAuthPlugin({
  auth,
  apiKey: {
    configId: "hot-updater",
    // headerName: "x-api-key",
    requiredPermissions: { hotUpdater: ["access"] },
  },
});
```

Configure the API-key plugin and its database schema in Better Auth:

```ts
import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  database,
  plugins: [
    apiKey({
      configId: "hot-updater",
      defaultPrefix: "hu_",
      enableSessionForAPIKeys: false,
      permissions: {
        defaultPermissions: { hotUpdater: ["access"] },
      },
      rateLimit: {
        enabled: true,
        maxRequests: 1_000,
        timeWindow: 60 * 60 * 1_000,
      },
    }),
  ],
});
```

Create the key from a trusted server-side path and keep the raw value in a
secret store:

```ts
const credential = await auth.api.createApiKey({
  body: {
    configId: "hot-updater",
    name: "mobile-client",
    permissions: { hotUpdater: ["access"] },
    userId: existingBetterAuthUser.id,
  },
});
```

Send `credential.key` as the `x-api-key` request header from standalone
plugins and React Native `requestHeaders`. A key embedded in a React Native
bundle is extractable; treat it as a client access gate, not strong
administrator authentication.

The plugin does not construct or mutate Better Auth, mount Better Auth HTTP
handlers, run Better Auth migrations, or expose session, cookie, and raw
API-key data. Better Auth `503` errors that remain observable are mapped to
authentication unavailability.
Better Auth 1.6.24 rewrites a memory-adapter session lookup `503` to an
`APIError` with status `INTERNAL_SERVER_ERROR` and status code `500`; that
erased classification is treated as an unexpected failure, so the kernel
returns an opaque `500`.
Better Auth's default logger can receive the original store error before that
rewrite. Deployments with strict log-secrecy requirements must disable or
sanitize the configured Better Auth logger; this plugin cannot safely mutate
the caller-owned instance.
Upstream integrations that catch an outage and return `null` make that outage
indistinguishable from an anonymous session, so the kernel will respond as it
does for anonymous authentication.
