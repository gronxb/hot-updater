---
"hot-updater": patch
---

Load `hot-updater db generate` configurations before their generated Drizzle
schema or conventional Prisma client exists, without writing placeholder files
or evaluating the root configuration module twice.
