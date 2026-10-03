---
"@hot-updater/supabase": patch
---

`supabaseStorage` stores keys that Supabase Storage rejects under escaped object names, and reads a missing object as `null`.

- Storage accepts object names of ASCII letters, digits and `_/!.*'() &$=@;:+,?-` only, and supabase-js puts a name in the request URL unencoded. A key with `#` or `?` was stored under the part of its name before that character, and a key with `%`, non-ASCII characters, or another character Storage rejects failed. Those characters, `?`, and `!` are now stored as `!` and the hex digits of their UTF-8 bytes, such as `#` as `!23`. The storage URI keeps the key. Objects whose names have none of these characters keep their names, which covers what deploy writes unless `basePath` or an asset's file extension has one.
- `get` of a missing object failed with `Failed to download storage object: {}` instead of returning `null`. It returns `null` when Storage answers `not_found`, and still fails for a missing bucket.
