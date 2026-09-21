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
    const [{ prepareConfig }, { getAppUsageReport }] = await Promise.all([
      import("./server/config.server"),
      import("./server/insightsUsage"),
    ]);
    const { config } = await prepareConfig();
    return getAppUsageReport(config.database.models.insights, data);
  });
