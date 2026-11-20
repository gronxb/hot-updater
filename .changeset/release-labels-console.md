---
"@hot-updater/console": patch
"hot-updater": patch
---

feat(console): the Console names each bundle by its label, and each native build by its version and build number.

- A bundle's label, such as `v12`, goes before its ID in the Bundles list and detail sheet, Insights, and a native build's **Served now**. Release health's **Add a bundle** finds a bundle by its label too, and a promotion's toast names the label the bundle took in its target channel.
- A native build shows as the stores show it, such as `1.7.0 (66)`: the store's version and build number once a store took it, else the artifact's. The Native builds list, its cards, and a build's page show it, `native-build find`, `download`, `install`, and `delete` print it as a `Build` row, and a pull request preview's comment names it on each install line and in **Builds**.
