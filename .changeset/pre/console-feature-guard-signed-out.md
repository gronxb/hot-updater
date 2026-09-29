---
"@hot-updater/console": patch
---

A signed-out visit to Insights, Distribution, Installations, or API keys renders the sign-in page instead of failing the server render. The feature guard no longer keeps its refused read in the query cache, whose 401 Response the render could not serialize.
