---
"hot-updater": minor
---

Remove the `hot-updater codemod` command and its `client-access` codemod. It only moved `clientAccess` objects from earlier release candidates to plugins, and release candidates keep no compatibility with each other: recreate the RC database, and update the server, app, and console together.
