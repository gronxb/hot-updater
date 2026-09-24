---
"hot-updater": minor
---

Add `hot-updater codemod client-access [paths...]`, which moves `createHotUpdater` calls from the 1.0 release candidates' `clientAccess` objects to plugins.

- **Rewrites:** `clientAccess: { type: "public" }` becomes `clientAccess: "public"`. `clientAccess: { type: "api-key", headerName? }` is removed, and `apiKeys()` joins `plugins`, with the same `headerName` when one was set. A call without `plugins` gets `insights()`, which the release candidates ran by default. Missing imports from `@hot-updater/server/plugins/api-keys` and `@hot-updater/server/plugins/insights` are added, as `require` calls in CommonJS files.
- **Edits in place:** the command parses each file with OXC and changes only the spans it rewrites, so formatting and comments survive. Calls that already use `clientAccess: "public"` or `plugins` stay as they are, so it can run again.
- **Reports:** a file with a call it cannot rewrite safely, such as a `clientAccess` or `plugins` value held in a variable or options built with a spread, is reported with its line and left unchanged, and the command exits with code 1.
- **Paths:** it takes files, directories, or globs, and defaults to the current directory without `node_modules`, `dist`, and `build`. `--dry-run` prints a unified diff and writes nothing.
