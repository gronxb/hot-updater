---
"hot-updater": minor
---

An Apple or Google sign-in no longer refuses a read-only `secrets` adapter such as the default `env()`. The CLI writes the issued key to `<cacheDir>/issued/<name>.json`, readable by your user alone, in a directory git ignores. It prints the file's path and the variables to store the key in, never the key itself. The build that signed in signs and uploads with the key from that file. With `env()`, if the project has a GitHub remote and you have a token, the CLI offers once to store the key as a GitHub Actions secret with `githubActions()`.

An adapter that stores the key but does not read it back on your machine, such as `githubActions()` outside a workflow, no longer stops the build. The CLI writes a copy to the same file, and the build continues with it.

Store the key, then delete the file: a later sign-in for the same name refuses to replace a key the file still holds. Before any sign-in, the CLI checks in this order:

- an environment override;
- a key the adapter holds;
- a terminal outside CI;
- somewhere for the key to go.
