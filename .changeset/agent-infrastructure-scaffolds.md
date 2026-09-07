---
"hot-updater": minor
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/firebase": patch
---

Add `hot-updater infra scaffold --provider <provider>` for standalone server
template extraction without an agent or app build selection. Reuse its extractor
in `hot-updater agent infra setup` and `hot-updater agent infra upgrade` to
generate versioned deployment templates and agent instructions for Cloudflare,
Supabase, AWS, and Firebase. Scaffolds preserve existing edits and provide
provider-specific verification, resume guidance, and private reusable API-key
provisioning. Agents apply the files through their available provider tools.

Connect doctor remediation to the agent commands and require a complete
version-named Markdown release file for every infrastructure requirement.
Retain historical files and provide an ordered index so agents can read the
complete upgrade path, including intermediate releases. Include the
v0-to-v1 coexistence and native-build transition as the initial upgrade record.
Share existing provider config builders with the packaged scaffolds.

Include provider environment guides explaining each variable's purpose,
conditions and secure source. Guide agents to discover the app and existing
resources, create missing infrastructure, and ask only for unresolved choices
or access, without requesting secrets in chat.
