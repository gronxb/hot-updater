---
"hot-updater": minor
---

feat(hot-updater): add `--provider` and `--build` flags to `init`

`hot-updater init` always prompts for the build plugin and the provider. These optional flags pre-answer those two prompts so `init` can run without interaction:

```
hot-updater init --provider cloudflare --build expo
```

When a flag is omitted, the prompt is shown as before. Values are validated against the known choices.

This is aimed at the Cloudflare redeploy flow described in #849: with a populated `.env.hotupdater`, re-running `init` redeploys the worker and applies pending migrations, and these flags remove the two prompts that otherwise block it from running unattended. Providers still prompt for any value that is not already present in `.env.hotupdater`.
