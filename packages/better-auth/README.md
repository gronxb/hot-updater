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

## Managed API key

Managed authentication and route protection are separate opt-ins:

```ts
import {
  managedBetterAuthPlugin,
  managedRoutePolicy,
} from "@hot-updater/better-auth/managed";
import { createHotUpdater } from "@hot-updater/server";

const hotUpdater = createHotUpdater({
  database,
  plugins: [
    managedBetterAuthPlugin({ apiKeySha256: env.API_KEY_SHA256 }),
    managedRoutePolicy({ scope: "management" }),
  ],
  routes: { bundles: true, updateCheck: true },
});
```

The `management` scope keeps the core version route and the four core OTA
selectors (app version and fingerprint, with and without cohort) public for
existing mobile clients. Similar route IDs contributed by plugins are still
protected, along with bundle-management and other feature routes. Use
`scope: "all"` only with a client-appropriate authentication flow and after
every deployed client sends credentials. Do not embed the managed static API key
in a public mobile binary; it is extractable and is intended for trusted
management tooling.

The Cloudflare, Firebase, and Supabase deployment workflows provision this key
and pass its digest to runtimes that compose `managedBetterAuthPlugin()` with
`analytics()`. They do not install a route policy: Core OTA routes and
Analytics ingestion stay public, while the six Analytics query routes use
their protected default. Bundle management is not mounted by those runtimes.
The AWS preset remains unchanged and does not install managed authentication
or Analytics.

Node infrastructure code can explicitly provision the raw key into
`.env.hotupdater` and deploy only its SHA-256 projection:

```ts
import { provisionManagedBetterAuthApiKey } from "@hot-updater/better-auth/managed/provisioning";

const { apiKey, sha256 } = await provisionManagedBetterAuthApiKey();
```

Keep `apiKey` in trusted management tooling and deploy only `sha256` to the
Hot Updater server. Neither value is sent to a provider by the provisioning
function.

Provisioning serializes concurrent writes with an adjacent owner-only lock. It
requires a user-owned parent directory and a user-owned regular target with one
hard link, opens paths without following symbolic links, and verifies `0600`
permissions. Existing files are replaced atomically after writing and syncing a
fresh owner-only file. Provisioning fails on Windows or filesystems that cannot
prove these POSIX guarantees. An existing lock is never reclaimed automatically;
the call times out without modifying it so stale-lock recovery remains an
explicit operator action.
