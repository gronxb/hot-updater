---
"hot-updater": minor
---

`githubActions({ repo?, environment?, token? })` from `hot-updater` stores secrets in a repository's GitHub Actions secrets, or an environment's. `set` encrypts the value as a libsodium sealed box for the repository's or environment's public key and stores it under its variable name, such as `HOT_UPDATER_ASC_API_KEY` for `asc-api-key`. GitHub never returns a value, so `get` reads names from the environment only inside a workflow run, where the workflow maps each secret to the variable of its name, and holds nothing elsewhere. The repository defaults to the `origin` remote's, and the token to `GH_TOKEN` or `GITHUB_TOKEN` unless it is a workflow's token, then to `gh auth token`. A workflow's `GITHUB_TOKEN` can't write secrets, so in CI without another token the adapter refuses with what to use instead. Requests go to `api.github.com` over HTTPS without following redirects, and the token and the value are masked in the CLI's output.
