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
    const [{ prepareConfig }, { getBundleActivity }, { requireInsightsModel }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/bundleActivity"),
        import("./server/runtime.server"),
      ]);
    const { insights } = await prepareConfig();
    return getBundleActivity(await requireInsightsModel(insights), data);
  });

export const getRecoveryReportRpc = createServerFn({ method: "GET" })
  .validator(readRecoveryInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getRecoveryReport }, { requireInsightsModel }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/insightsRecovery"),
        import("./server/runtime.server"),
      ]);
    const { insights } = await prepareConfig();
    return getRecoveryReport(await requireInsightsModel(insights), data);
  });
