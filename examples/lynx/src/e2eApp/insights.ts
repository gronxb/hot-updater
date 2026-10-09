import { HotUpdater } from "@hot-updater/lynx";
import { insights } from "@hot-updater/plugin-insights/client";
import { remoteConfig } from "@hot-updater/plugin-remote-config/client";

export function createE2eUpdater(baseURL: string) {
  const updater = HotUpdater.init({
    baseURL,
    requestTimeout: 15_000,
    plugins: [
      insights({ debug: true }),
      remoteConfig({
        defaults: {
          e2e_flag: true,
          e2e_limit: 1,
          e2e_message: "in-app default",
        },
        minimumFetchIntervalMs: 0,
      }),
    ],
  });
  // Console QA identifies the installation by this explicit test user.
  updater.insights.setUser({ userId: "detox-e2e" });
  return updater;
}
