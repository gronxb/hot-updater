---
"hot-updater": patch
---

feat(cli): add `bundle list/disable/enable` commands

Adds three subcommands under a new top-level `bundle` namespace:

- `hot-updater bundle list [-c <channel>] [-p <ios|android>] [--limit <n>]` — tabulated listing of bundles, most recent first. `--limit` validation uses commander's idiomatic `InvalidArgumentError` shape.
- `hot-updater bundle disable <bundle-id> [-y]` — disable a single bundle. Refuses to mutate without `-y` in a non-TTY shell. Re-reads the bundle after `commitBundle` and exits non-zero if the change did not take effect; treats a mid-flight deletion as success.
- `hot-updater bundle enable <bundle-id> [-y]` — re-enable a previously disabled bundle.

All three commands load config via `loadConfig(null)` (matching the `console` command's idiom) since they are not platform-scoped operations. They use the existing `DatabasePlugin` interface (`getBundles`, `getBundleById`, `updateBundle`, `commitBundle`), so they work against every supported provider with no plugin-side changes. The `--platform` option is the shared `platformCommandOption` already used by `deploy`. `onUnmount` is wrapped in its own try/catch so cleanup errors never mask the originating mutation error. Help text documents the read-mutate-verify contract and exit codes (0 = success, 1 = error, 2 = user-aborted).
