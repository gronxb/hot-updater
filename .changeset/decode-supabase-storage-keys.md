---
"@hot-updater/supabase": patch
---

Decode percent-encoded object keys when parsing `supabase-storage://` URIs. Supabase upload responses echo a percent-encoded key, so an asset such as `logo-ios@2x.png` is stored as `logo-ios%402x.png`. Storage API calls that carry the key in the request path decode it server side, but `createSignedUrls` and `remove` send keys in the JSON body and looked up an object that does not exist, which failed update checks with "Either the object does not exist or you do not have access to it".
