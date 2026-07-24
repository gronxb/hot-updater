# @hot-updater/better-auth

Connect a configured Better Auth instance to the Hot Updater server kernel.
The plugin reads sessions through `auth.api.getSession({ headers })` and maps
only `user.id` to the kernel principal.

```ts
import { betterAuthPlugin } from "@hot-updater/better-auth";

const plugin = betterAuthPlugin({ auth });
```

The plugin does not construct or mutate Better Auth, mount HTTP handlers,
configure API keys, or expose session and cookie data. Better Auth `503`
errors that remain observable are mapped to authentication unavailability.
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
