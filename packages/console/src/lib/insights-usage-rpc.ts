import { createServerFn } from "@tanstack/react-start";

import { readAppUsageInput, type AppUsageInput } from "./insights-usage";

export const getAppUsageReportRpc = createServerFn({ method: "GET" })
  .validator((input: AppUsageInput) => {
    readAppUsageInput(input);
    return {
      platform: input.platform,
      channel: input.channel,
      appVersion: input.appVersion,
      window: input.window,
    };
  })
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getAppUsageReport }, { requireFeature }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/insightsUsage"),
        import("./server/runtime.server"),
      ]);
    const { runtime } = await prepareConfig();
    return getAppUsageReport(
      await requireFeature(runtime, "insightsAnalytics"),
      data,
    );
  });
