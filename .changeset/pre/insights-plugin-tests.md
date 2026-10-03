---
"@hot-updater/test-utils": minor
"@hot-updater/server": minor
---

`setupDatabaseTestSuite` runs core's suites only; server plugins' suites run when a provider lists them in `plugins`. The Insights suites moved to the Insights plugin: pass `insightsTestSuite({ createModel })` from `@hot-updater/server/plugins/insights/testing`, which also exports `setupInsightsModelTestSuite` and `createBundleEventRowFixture`, and serve `insights()` from `createHttpClient`. `createInsightsModel` is no longer an option of `setupDatabaseTestSuite`, and `@hot-updater/test-utils` no longer exports the Insights suites.
