---
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
"hot-updater": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
---

Keep an `UNCHANGED` report as an event when it changes what its installation runs, and count each release's downloads, launches, and crashes once per installation. The server compares a report with the installation's latest report and keeps it when it is the installation's first report (**First seen**), a new app version or native build (**App updated**), another bundle with no apply report for it (**Launched**), another Release of the bundle it already runs (**Release adopted**), or another channel. A user switch, and a launch that changes nothing, keep no event, so daily launches cost what they did. All Events and installation history show each change once, with what came before.

A release's launches count its apply reports and the kept reports that moved an installation onto it when no apply report came. A launch or crash whose download report never arrived counts that download too. A download or apply that arrives after its installation already ran the bundle, as a reload can deliver it, counts nothing and moves no latest report. Once every installation restarts, a release's downloads equal its launches plus crashes. The Console's Bundles list shows **Downloaded**, **Launched**, and **Crashed**, and the bundle detail shows downloads not launched yet; a release of the built-in bundle shows no downloads. Release health's **Adoption** counts launches per interval or as a running total, and the crash rate is crashes ÷ (launches + crashes). `InsightsBundleEventFilter` accepts `UNCHANGED`, under a new `on:` key that `UNCHANGED` rows kept by older servers never used, so those count as no launch. No table changes: no migration is needed.
