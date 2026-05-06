---
"hot-updater": patch
---

feat(cli): add `bundle promote` command

Move or copy a bundle to a different channel from the CLI, mirroring the console's Promote-to-Channel UI.

```
hot-updater bundle promote <bundle-id> -t <target-channel> [-a copy|move] [-y]
```

- The bundle id is positional — the bundle carries its own source channel, so no `--source` flag is needed.
- `--action copy` (default) creates a new bundle id on the target channel and leaves the original in place — CodePush-promote semantics.
- `--action move` updates the bundle's `channel` column without creating a new bundle (D1-only mutation; no R2 work).
- Wraps the `promoteBundle` function from `@hot-updater/cli-tools`, so the CLI and console use one implementation. Surfaces the underlying `LEGACY_BUNDLE_ERROR` and signing/storage configuration errors directly.

Pre-flight: rejects bundle-already-on-target, missing bundle id, empty target. Refuses to mutate without `-y` in a non-TTY shell. Lives under the `bundle` namespace alongside `bundle list/disable/enable` since the noun being mutated is the bundle (its channel attribute, or a copy of it).
