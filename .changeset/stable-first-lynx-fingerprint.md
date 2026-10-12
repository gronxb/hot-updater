---
"@hot-updater/lynx-build": patch
---

Keep the first native fingerprint stable when the CLI embeds it in a new Lynx
application using UTF-8 XML. Normalize XML serialization and exclude the
generated fingerprint entry while retaining ordinary native settings in the
hash. Preserve binary and other XML encodings as bytes.
