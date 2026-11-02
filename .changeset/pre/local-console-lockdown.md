---
"@hot-updater/console": patch
"hot-updater": patch
---

`hot-updater console` prints a link with a session made for that run, and the local Console answers only the browser that opened it, only at `localhost`, `127.0.0.1`, or `[::1]` on its port, and only changes sent from its own pages. Every Console, hosted or local, now lists TanStack Start's same-origin check for server functions explicitly, and every server function that changes something validates its input.
