---
"hot-updater": patch
---

fix(cli): make multi-platform deploy a first-class flow

`hot-updater deploy` now handles the no-`-p` path inside the deploy command
itself instead of looping from the CLI entrypoint. This keeps the banner and
success output consistent, makes it explicit that iOS and Android are deployed
sequentially, and writes local bundle archives to platform-specific output
directories so one platform no longer overwrites the other.
