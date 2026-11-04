---
"hot-updater": patch
"@hot-updater/cli-tools": patch
---

Fix findings from the 1.2.0-rc.16 QA.

- `doctor --scope scaffold` and `--scope infrastructure` no longer block a scaffold another CLI version generated when its deployment files differ from this CLI's templates only in their version strings and its server is the release whose schema and API this CLI needs. They demanded the CLI's own versions, so a CLI-only release blocked every managed deployment and pushed a version-only redeploy. A scaffold whose server is older is blocked with the release it needs, why, and `agent infra upgrade`; one whose deployment files differ otherwise names those files.
- `secrets import` and `init` word a conflict on one name in the singular: `holds another value for:` and `Back it up`.
