# @hot-updater/plugin-insights

Hot Updater's Insights plugin. The server plugin records launches, downloads,
and update failures and serves them to the Console and the CLI; the client
plugin reports them from the app.

You don't install it on its own. `@hot-updater/server` and
`@hot-updater/react-native` depend on it and re-export it:

```ts
// The server definition
import { insights } from "@hot-updater/server/plugins/insights";

// The app
import { HotUpdater, insights } from "@hot-updater/react-native";
```

| Entry       | Re-exported as                                                     |
| ----------- | ------------------------------------------------------------------ |
| `./server`  | `@hot-updater/server/plugins/insights`                             |
| `./client`  | `insights` and its types from the `@hot-updater/react-native` root |
| `./testing` | `@hot-updater/server/plugins/insights/testing`                     |

See [Insights](https://hot-updater.dev/docs/guides/insights).
