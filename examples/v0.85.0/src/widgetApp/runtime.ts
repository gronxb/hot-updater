import { HotUpdater } from "@hot-updater/react-native";

import { HOT_UPDATER_API_KEY } from "../e2eBuildConfig";
import { resolveHotUpdaterBaseURL } from "../e2eRuntimeConfig";

// The same server as the example. The native module of this runtime works on
// the instance whose bundle it runs, `widget`, so the channel, bundle, and
// crash history it reports are the widget's. No plugins: Console Insights
// evidence stays the example's.
export const hotUpdater = HotUpdater.init({
  baseURL: resolveHotUpdaterBaseURL,
  requestHeaders: HOT_UPDATER_API_KEY
    ? { "x-api-key": HOT_UPDATER_API_KEY }
    : undefined,
  requestTimeout: 15000,
  onError: (error) => {
    console.error(error);
  },
});
