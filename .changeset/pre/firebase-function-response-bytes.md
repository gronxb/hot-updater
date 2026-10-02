---
"@hot-updater/firebase": patch
---

The managed Firebase Cloud Function sends each response body byte for byte, so binary responses arrive unchanged, where rc.20 decoded every body as text. It also sends each `Set-Cookie` header the server sets as its own header, where rc.20 kept only the last one.
