---
"hot-updater": patch
---

feat(cli): add `rollback <channel>` command

Disables the most recent enabled bundle on a channel for each requested platform. Operationally equivalent to revealing the second-most-recent bundle as the channel's active update.

```
hot-updater rollback <channel> [-p ios|android] [-y] [--confirm-revert-to-binary]
```

Behavior:

- **Read phase** loads up to two most-recent enabled bundles per (channel, platform) so the operator can see what would become active after rollback.
- **Validate phase** refuses with non-zero exit if any (channel, platform) would have **no** enabled bundles after the rollback unless `--confirm-revert-to-binary` is passed. This prevents an accidental fall-back to the binary-shipped JS.
- **Mutate phase** queues `updateBundle({ enabled: false })` for each target and commits once. Note: `DatabasePlugin.commitBundle` runs ops sequentially, so atomicity across platforms is **not** guaranteed at the underlying provider.
- **Verify phase** re-reads each target. Surfaces partial-failure state explicitly with non-zero exit and per-platform `FAILED` lines so the operator knows exactly what to retry.

Refuses to mutate without `-y` in a non-TTY shell.
