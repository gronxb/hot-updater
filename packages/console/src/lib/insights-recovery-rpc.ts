import { createServerFn } from "@tanstack/react-start";

import type { BundleActivityInput } from "./bundle-activity";
import { consoleAccess } from "./console-access";
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
  .middleware([consoleAccess])
  .validator(readBundleActivityInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getBundleActivity }, { requireFeature }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/bundleActivity"),
        import("./server/runtime.server"),
      ]);
    const { runtime } = await prepareConfig();
    return getBundleActivity(
      await requireFeature(runtime, "insightsAnalytics"),
      data,
    );
  });
