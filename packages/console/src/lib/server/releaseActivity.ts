import type {
  InsightsModel,
  ReleaseReference,
} from "@hot-updater/server/plugins";

import type { ReleaseActivityInput } from "../release-activity";

export async function getReleaseActivity(
  model: InsightsModel,
  inputs: readonly ReleaseActivityInput[],
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
                launched: item.metrics.applies,
                failedLaunches: item.metrics.failedLaunches,
                measuredAtMs: activity.measuredAtMs,
              },
            ],
          ],
    ),
  );
}
