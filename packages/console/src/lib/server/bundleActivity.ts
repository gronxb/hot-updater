import type { InsightsModel, ReleaseReference } from "@hot-updater/plugin-core";

import type { BundleActivityInput } from "../bundle-activity";

export async function getBundleActivity(
  model: InsightsModel,
  inputs: readonly BundleActivityInput[],
) {
  if (inputs.length === 0) return {};
  const releases: ReleaseReference[] = inputs.map((input) => ({
    releaseId: input.releaseId,
    platform: input.platform,
    channel: input.channel,
  }));
  const activity = await model.getReleaseActivity({ releases });
  return Object.fromEntries(
    activity.data.flatMap((item) =>
      item.release === undefined
        ? []
        : [
            [
              item.release.releaseId,
              {
                downloads: item.metrics.downloads,
                launches: item.metrics.launches,
                failedLaunches: item.metrics.failedLaunches,
                measuredAtMs: activity.measuredAtMs,
                coverage: activity.coverage,
              },
            ],
          ],
    ),
  );
}
