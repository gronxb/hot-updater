---
"@hot-updater/console": minor
"hot-updater": patch
---

Package the full Console application behind root and `/vite` exports so a thin
Vite and Nitro host can deploy it with injected runtime configuration and
authentication. Keep the CLI console unauthenticated but force it to bind to
the loopback interface.
