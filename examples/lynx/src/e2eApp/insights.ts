import { HotUpdater } from "@hot-updater/lynx";
import { insights } from "@hot-updater/plugin-insights/client";

export function createE2eUpdater(baseURL: string) {
  const updater = HotUpdater.init({
    baseURL,
    requestTimeout: 15_000,
    plugins: [insights({ debug: true })],
  });
  // Console QA identifies the installation by this explicit test user.
  updater.insights.setUser({ userId: "detox-e2e" });
  return updater;
}
