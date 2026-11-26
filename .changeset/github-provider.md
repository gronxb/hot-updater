---
"@hot-updater/github": patch
---

Add `@hot-updater/github`: `githubReleaseStorage` stores bundles as release assets of a GitHub repository, which can be private, and resolves the signed URLs GitHub issues for them; `githubJsonDatabase` keeps the metadata as one JSON file in the repository, written with the Contents API's compare-and-swap. `githubUpdateFetch` from `@hot-updater/github/client` answers update checks inside the app from that repository, for an app without an update server.
