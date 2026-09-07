import { createServerFn } from "@tanstack/react-start";

import { readRecoveryInput } from "./insights-recovery";

export const getRecoveryReportRpc = createServerFn({ method: "GET" })
  .validator(readRecoveryInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getRecoveryReport }] = await Promise.all([
      import("./server/config.server"),
      import("./server/insightsRecovery"),
    ]);
    const { config } = await prepareConfig();
    return getRecoveryReport(config.database.models.insights, data);
  });
