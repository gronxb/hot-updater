# `@hot-updater/better-auth`

Use a configured [Better Auth](https://www.better-auth.com/) instance as an
authentication provider for protected Hot Updater routes.

## Better Auth API keys

Configure API keys in Better Auth itself. The Hot Updater plugin only asks
Better Auth for the session represented by the request headers.

```ts
import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { betterAuthPlugin } from "@hot-updater/better-auth";
import { createHotUpdater } from "@hot-updater/server";

const auth = betterAuth({
  database: yourBetterAuthDatabase,
  plugins: [
    apiKey({
      enableSessionForAPIKeys: true,
    }),
  ],
});

export const hotUpdater = createHotUpdater({
  database: yourHotUpdaterDatabase,
  plugins: [betterAuthPlugin({ auth })],
});
```

`betterAuthPlugin({ auth })` only contributes authentication. Route access is
defined by the server routes and policy plugins composed by the application.
With `enableSessionForAPIKeys`, the default `x-api-key` header can supply a
session to protected routes.

The Better Auth handler is not mounted or exposed by this plugin. Mount it
separately if your application needs Better Auth's own HTTP endpoints.

## Managed client access keys

The managed Better Auth plugin owns its access-key component schema and binds it
through the database plugin's provider-neutral universal component adapter. A
database plugin does not import Better Auth or implement an access-key store:

```ts
import {
  managedBetterAuthPlugin,
  managedRoutePolicy,
} from "@hot-updater/better-auth/managed";
import { createHotUpdater } from "@hot-updater/server";

const hotUpdater = createHotUpdater({
  database,
  plugins: [managedBetterAuthPlugin(), managedRoutePolicy({ scope: "client" })],
});
```

The `client` role grants only OTA reads and Analytics writes. It cannot read
Analytics, manage bundles, or create and revoke keys. Validation is a read-only
SHA-256 lookup so normal OTA and Analytics traffic does not write authentication
metadata. Keys are a minimum abuse-control boundary rather than a strong secret:
an API key embedded in a public mobile binary can be extracted.

The `management` scope remains available for session-based management clients.
It keeps the core version route and the four core OTA selectors public. Use
`scope: "all"` only after every route has an appropriate authentication flow.

Managed `init` composition provisions the first client key into
`.env.hotupdater` and registers its hash and metadata through the same Better
Auth-owned component store. Custom Node composition can call the provisioning
helper with that component store explicitly:

```ts
import { provisionManagedBetterAuthApiKey } from "@hot-updater/better-auth/managed/provisioning";

const { apiKey, created } = await provisionManagedBetterAuthApiKey({
  name: "Default",
  store,
});
```

The raw key is returned so `hot-updater init` can print it once. The env file
keeps the key for local client configuration; universal component storage
receives only the SHA-256 digest, prefix, role, status, and timestamps.
Re-running provisioning reuses the same active key instead of creating
duplicates.

The Console binds the same Better Auth-owned component schema through the
provider-neutral adapter. It supports multiple active keys with create, list,
and revoke operations, and shows newly created plaintext keys once.

Provisioning serializes concurrent writes with an adjacent owner-only lock. It
requires a user-owned parent directory and a user-owned regular target with one
hard link, opens paths without following symbolic links, and verifies `0600`
permissions. Existing files are replaced atomically after writing and syncing a
fresh owner-only file. Provisioning fails on Windows or filesystems that cannot
prove these POSIX guarantees. An existing lock is never reclaimed automatically;
the call times out without modifying it so stale-lock recovery remains an
explicit operator action.
