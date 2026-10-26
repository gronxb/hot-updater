# @hot-updater/plugin-insights

Hot Updater's Insights plugin. The server plugin records launches, downloads,
and update failures and serves them to the Console and the CLI; the client
plugin reports them from the app.

You don't install it on its own. `@hot-updater/server` and
`@hot-updater/react-native` depend on it and re-export it.

For `hot-updater.config.ts`, import the factory from the CLI's plugin entry:

```ts
import { insights } from "hot-updater/plugins";
```

For the server definition and app, use their runtime entries:

```ts
// The server definition
import { insights } from "@hot-updater/server/plugins";

// The app
import { HotUpdater, insights } from "@hot-updater/react-native";
```

| Entry      | Re-exported as                                                     |
| ---------- | ------------------------------------------------------------------ |
| `./server` | `@hot-updater/server/plugins`                             |
| `./client` | `insights` and its types from the `@hot-updater/react-native` root |

Its test suites, such as `insightsTestSuite`, are in `@hot-updater/test-utils`.

See [Insights](https://hot-updater.dev/docs/guides/insights).
