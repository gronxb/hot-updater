---
"hot-updater": patch
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/standalone": patch
---

fix(server): never call a release catalog stale, or rewrite it without its fields, because a later Hot Updater compiled fields this one doesn't know

- An rc.50 CLI against catalogs rc.51 compiled with labels reported `RELEASE_CATALOG_STALE` on every labeled scope, and its deploy or `bundle update` rewrote the scope's catalog without labels, so apps read `getReleaseLabel()` as null until a newer CLI rebuilt it. From this release on, an older Hot Updater handles a later one's catalogs safely.
- Core compares a stored catalog by the fields its compiler writes. A catalog that matches in those, with keys only a later release writes, is verified: doctor reports no issue, and a rebuild or the label fill leaves it as it is.
- A release change in such a scope, such as a deploy, `bundle update`, or enabling or disabling a bundle, is refused with `CATALOG_FROM_LATER_RELEASE` before anything is written: "The ios release catalog of channel "production" was written by a later Hot Updater. Upgrade hot-updater, then try again." A standalone server's refusal reaches its CLI with the same code.
- `hot-updater deploy` to both platforms ends a refusal core words for the user, this one or a catalog over its size limit, with that message and exit code 1. Before, it printed a stack trace.
