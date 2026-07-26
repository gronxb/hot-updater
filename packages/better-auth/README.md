# `@hot-updater/better-auth`

Protect every HTTP route created by `createHotUpdater` with a configured
[Better Auth](https://www.better-auth.com/) instance.

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

Installing `betterAuthPlugin({ auth })` contributes a `protect-all` route
policy. Core routes and routes added by other Hot Updater plugins therefore
require a Better Auth session. With `enableSessionForAPIKeys`, the default
`x-api-key` header can supply that session.

The Better Auth handler is not mounted or exposed by this plugin. Mount it
separately if your application needs Better Auth's own HTTP endpoints.

## Managed providers

Managed provider runtimes use a digest-only projection of a provisioned key:

```ts
import { managedBetterAuthPlugin } from "@hot-updater/better-auth/managed";

const authentication = managedBetterAuthPlugin({
  apiKeySha256: env.API_KEY_SHA256,
});
```

This shared key is bundled into managed mobile clients. Anyone who extracts it
can call every Hot Updater route mounted by that managed runtime. AWS mounts
`/version` and update checks; Cloudflare, Firebase, and Supabase additionally
mount Analytics ingestion and query routes. The managed presets do not mount
bundle management routes. The key is an access gate, not privileged or
tenant-scoped authorization. Use a custom server-side authorization gateway
when route-level privilege separation is required.

Node-based infrastructure code can provision the raw key into
`.env.hotupdater` and pass only its SHA-256 projection to the runtime:

```ts
import { provisionManagedBetterAuthApiKey } from "@hot-updater/better-auth/managed/provisioning";

const { sha256 } = await provisionManagedBetterAuthApiKey();
```

Provisioning serializes concurrent writes with an adjacent owner-only lock
directory. The target must be a user-owned regular file with one hard link,
its user-owned parent must not be writable by group or other users, and the
requested and canonicalized directory chains are checked for replaceable
ancestors after rejecting non-root-owned symbolic links; every ancestor must
be owned by root or the effective user. Sticky temporary directories are
supported when the next child is user-owned. When adding a generated key to an
existing file, provisioning writes the complete next content to a fresh
verified `0600` inode and atomically replaces the path; it never appends the
secret to the old inode. Provisioning fails on Windows or filesystems that
cannot prove these POSIX guarantees.
