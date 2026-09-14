import type { InsightsModel } from "@hot-updater/plugin-core";

import type { BundleActivityInput } from "../bundle-activity";

export async function getBundleActivity(
  model: InsightsModel,
  inputs: readonly BundleActivityInput[],
  _now?: number,
) {
  if (inputs.length === 0) return {};
  const activity = await model.getReleaseActivity({
    releases: inputs.map((input) => ({
      releaseId: input.releaseId,
      platform: input.platform,
      channel: input.channel,
    })),
  });
  return Object.fromEntries(
    activity.data.map((item) => [
      item.release.releaseId,
      {
        coverage: activity.coverage,
        measuredAtMs: item.measuredAtMs,
        summary: item.summary,
        truncated: activity.coverage.kind === "partial",
      },
    ]),
  );
}
