---
"@hot-updater/server": patch
---

Release Catalog responses add `CDN-Cache-Control: public, max-age=5, stale-while-revalidate=5, stale-if-error=0`. `s-maxage` forbids serving stale, so Cloudflare's Workers Cache held update checks at a location while it revalidated an expired catalog; it now answers with the expired catalog for up to five more seconds while it revalidates in the background. `Cache-Control` is unchanged for devices and other caches. Behind Workers Cache, a deploy or a Roll back reaches devices within 15 seconds instead of 10.
