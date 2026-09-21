---
"hot-updater": patch
"@hot-updater/cli-tools": patch
---

Stop installing dotenv during init. Generate configs with Node's built-in environment loader, allow CI to supply environment variables without a local env file, and preserve existing environment setup when merging configs.

Use Node's native environment parser for server verification and remove dotenv from generated infrastructure dependency lists and API-key configs.
