import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";
import { readRecoveryInput } from "./insights-recovery";
import type { ReleaseActivityInput } from "./release-activity";

export function readReleaseActivityInput(
  inputs: readonly ReleaseActivityInput[],
) {
  if (!Array.isArray(inputs) || inputs.length > 20)
    throw new Error("Choose up to 20 bundles.");
  return inputs.map((input) => {
    readRecoveryInput({ ...input, window: "30d" });
    if (!input.releaseId) throw new Error("Choose a bundle ID.");
    return input;
  });
}

export const getReleaseActivityRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readReleaseActivityInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getReleaseActivity }, { requireFeature }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/releaseActivity"),
        import("./server/runtime.server"),
      ]);
    const { runtime } = await prepareConfig();
    return getReleaseActivity(
      await requireFeature(runtime, "insightsAnalytics"),
      data,
    );
  });
