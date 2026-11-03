---
"@hot-updater/console": patch
---

The Console's Native builds page lists builds in a column table like the Bundles page's, one kind of value per column: Artifact, Channel, Platform, Build, Target, Build key, Store, Size, Built-in bundle, Commit, and Created. Target shows what OTAs target as the Bundles Target column shows it (the fingerprint, or the app version), and Build key shows the native build key of the build's inputs. The store badge's tooltip says when the build was submitted. Both tables share one shell and their cells, and a narrow screen shows each build as a card. A build's page shows the same Target, Build key, and Build.

Channel badges take their colors from the theme's `channel-*` tokens, with AA contrast in light and dark, and table headers read at AA contrast.

Native builds and Bundles page with the same Newest, Previous, and Next links, open a row from the keyboard the same way, show when an item was created as relative time with the exact time on hover (and under it on a card), and say what fills an empty list with an icon, a title, and the action that fills it. A Bundles card shows its target as the table's pill, and a native build's built-in bundle shows as a bundle ID does.
