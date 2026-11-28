---
"@hot-updater/console": patch
---

Insights filters now sit in one bar above every report and apply as you change them: Channel (production by default), one Platform filter for every report (all platforms by default), App version, and Release. A filter narrower than its default is highlighted and can be cleared on its own, Reset filters clears them all, and each report names the channel and platform it reads. Release health opens on the bundles devices get now (the newest live bundle of each platform, or the two newest of one platform) instead of the newest deployments, which could be rolled back. Add a bundle is a searchable combobox with Live and Not live groups, and each bundle shows its platform, target app version, and whether it is disabled or unreachable. Update failures cover both platforms when no platform is chosen.
