---
"@hot-updater/cli-tools": patch
---

The native fingerprint of React Native CLI and Rock projects hashes text files with CRLF line endings as LF, so a Windows checkout, where Git converts line endings by default, gets the same fingerprint as macOS and Linux. Binary files, which Git leaves alone, are hashed as they are. A project whose fingerprinted native files are committed with CRLF line endings gets a new fingerprint once.
