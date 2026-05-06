---
"hot-updater": patch
---

feat(cli): add `rollback <channel>` command

Disables the most recent enabled bundle on a channel for each requested platform.

```
hot-updater rollback <channel> [-p ios|android] [-y] [--confirm-revert-to-binary] [--target <bundle-id>]
```

Behavior:

- **Read phase** loads up to two most-recent enabled bundles per (channel, platform) so the operator can see what would become active after rollback.
- **Validate phase** refuses with non-zero exit if any (channel, platform) would have **no** enabled bundles after the rollback unless `--confirm-revert-to-binary` is passed. The error message names both safe escape hatches in priority order: `-p <unaffected>` first, then `--confirm-revert-to-binary`.
- **Mutate phase** queues `updateBundle({ enabled: false })` for each target and commits once. Note: `DatabasePlugin.commitBundle` runs ops sequentially in the underlying provider, so atomicity across platforms is **not** guaranteed. The mutate is wrapped in a try/catch so a mid-commit throw still falls through to the verify phase.
- **Verify phase** re-reads each target. Distinguishes three states — disabled (success), still-enabled (failure), and gone (success: a deleted bundle satisfies the rollback intent). Surfaces partial-failure state explicitly with non-zero exit and per-platform `FAILED` lines naming the exact retry command, including a `--target <bundle-id>` flag for scoped retry.

Refuses to mutate without `-y` in a non-TTY shell. `onUnmount` is wrapped in its own try/catch so cleanup errors never mask the originating mutation error. Help text documents the four-phase contract and exit codes (0 = success, 1 = error, 2 = user-aborted).
