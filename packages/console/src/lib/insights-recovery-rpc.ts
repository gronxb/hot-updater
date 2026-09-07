import { createServerFn } from "@tanstack/react-start";

import type { BundleActivityInput } from "./bundle-activity";
import { readRecoveryInput } from "./insights-recovery";

export function readBundleActivityInput(
  inputs: readonly BundleActivityInput[],
) {
  if (!Array.isArray(inputs) || inputs.length > 20)
    throw new Error("Choose up to 20 bundles.");
  return inputs.map((input) => {
    readRecoveryInput({ ...input, window: "30d" });
    if (!input.releaseId) throw new Error("Choose a bundle ID.");
    return input;
  });
}

export const getBundleActivityRpc = createServerFn({ method: "GET" })
  .validator(readBundleActivityInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getBundleActivity }] = await Promise.all([
      import("./server/config.server"),
      import("./server/bundleActivity"),
    ]);
    const { config } = await prepareConfig();
    return getBundleActivity(config.database.models.insights, data);
  });

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
