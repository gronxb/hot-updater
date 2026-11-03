---
"@hot-updater/console": patch
---

Download a native build without a Console session through a signed link.

- A build's page creates a link, `/api/native-builds/<build id>/download?t=<token>`, that works for 30 days for that build only, and a script can `curl`. The Console signs it with a key derived from `BETTER_AUTH_SECRET` and stores nothing. An expired or changed link answers `403`; requests without a token still ask for the session, and a local console still asks for its own.
- A valid link redirects to the storage's download URL. When the storage gives no URL a browser can fetch, including when it can't sign one, the Console streams the file through `storage.get`, which costs more: the docs say so.
