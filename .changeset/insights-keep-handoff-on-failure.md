---
"@hot-updater/plugin-insights": patch
---

Keep a report held for the next launch when all its attempts fail, such as on an offline launch, so a later launch can still deliver it. It leaves storage when the server accepts or refuses it, or when its attempts fail after 30 days.
