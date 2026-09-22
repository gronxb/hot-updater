---
"hot-updater": patch
"@hot-updater/cli-tools": patch
---

Stop installing dotenv during init. Generate configs with Node's built-in environment loader, allow CI to supply environment variables without a local env file, and preserve existing environment setup when merging configs.

Remove direct dotenv dependencies from examples and server examples, replace react-native-dotenv in mobile examples with explicit public configuration, and update the documentation. Preserve public E2E build settings for manual launches.
