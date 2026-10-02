---
"@hot-updater/console": patch
---

The Console builds on TanStack Start 1.168.60, with TanStack Router, Router SSR Query, and TanStack Query updated to match. Vercel refuses to deploy TanStack Start 1.168.25 as vulnerable to XSS. The scroll-restoration helper reads the matched route from the router's tuple result.
