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

export const getReleaseActivityRpc = createServerFn({ method: "GET" })
  .validator(
    (
      input: BundleActivityInput & { readonly window: "24h" | "7d" | "30d" },
    ) => {
      readBundleActivityInput([input]);
      readRecoveryInput(input);
      return input;
    },
  )
  .handler(async ({ data }) => {
    const { prepareConfig } = await import("./server/config.server");
    const { config } = await prepareConfig();
    const hours = data.window === "24h" ? 24 : data.window === "7d" ? 168 : 720;
    const end = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    const start = end - hours * 3_600_000;
    const activity = await config.database.models.insights.getReleaseActivity({
      releases: [
        {
          releaseId: data.releaseId,
          platform: data.platform,
          channel: data.channel,
        },
      ],
      timeRange: { start, end },
    });
    const knownStart =
      activity.coverage.sinceMs === null
        ? null
        : Math.max(
            start,
            Math.ceil(activity.coverage.sinceMs / 3_600_000) * 3_600_000,
          );
    return {
      ...activity,
      data: activity.data.map((item) => {
        const byHour = new Map(
          item.series?.map((point) => [point.startMs, point]),
        );
        const series = [];
        for (let startMs = start; startMs < end; startMs += 3_600_000) {
          series.push(
            byHour.get(startMs) ?? {
              startMs,
              downloadedReports:
                knownStart !== null && startMs >= knownStart ? 0 : null,
              appliedReports:
                knownStart !== null && startMs >= knownStart ? 0 : null,
              recoveredReports:
                knownStart !== null && startMs >= knownStart ? 0 : null,
            },
          );
        }
        return { ...item, series };
      }),
    };
  });

export const getRecoveryReportRpc = createServerFn({ method: "GET" })
  .validator(readRecoveryInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getAggregatedRecoveryReport }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/insightsRecovery"),
      ]);
    const { config } = await prepareConfig();
    return getAggregatedRecoveryReport(config.database.models, data);
  });
