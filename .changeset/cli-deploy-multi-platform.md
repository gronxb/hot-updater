---
"hot-updater": patch
---

feat(cli): `deploy` runs both platforms when `-p` is omitted

`hot-updater deploy` (without `-p ios` or `-p android`) now deploys ios then android sequentially. If ios fails, android is not attempted — the channel is never left half-updated. This is the typical CI/CD invocation pattern.

```
hot-updater deploy -c dev               # ios + android, sequential, abort-on-first-failure
hot-updater deploy -p ios -c dev        # unchanged: single platform
hot-updater deploy -i -c dev            # unchanged: interactive prompt for one platform
```

Existing `-p ios` / `-p android` invocations are unchanged; `-i` (interactive) still prompts for a single platform. The change is purely in the no-`-p`-no-`-i` path, which previously errored with "Platform not found" — that error path is now the multi-platform deploy.
