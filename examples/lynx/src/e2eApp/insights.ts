import { insights } from "@hot-updater/plugin-insights/client";

export const analytics = insights();
// The shared Console QA locates this installation by its explicit test user.
analytics.setUser({ userId: "detox-e2e" });
