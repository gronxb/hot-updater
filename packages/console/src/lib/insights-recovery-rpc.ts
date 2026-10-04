import { createServerFn } from "@tanstack/react-start";

import type { BundleActivityInput } from "./bundle-activity";
import { consoleAccess } from "./console-access";
import { readRecoveryInput } from "./insights-recovery";
import {
  readDownloadsReleaseInput,
  readDownloadsReleasesInput,
  readReleaseDownloadsInput,
} from "./release-downloads";

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

export const getRecoveryReportRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readRecoveryInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getRecoveryReport }, { requireFeature }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/insightsRecovery"),
        import("./server/runtime.server"),
      ]);
    const { runtime } = await prepareConfig();
    return getRecoveryReport(
      await requireFeature(runtime, "insightsAnalytics"),
      data,
    );
  });

export const listDownloadsReleasesRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readDownloadsReleasesInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { listDownloadsReleases }] = await Promise.all([
      import("./server/config.server"),
      import("./server/releaseDownloads"),
    ]);
    const { core } = await prepareConfig();
    return listDownloadsReleases(core, data);
  });

export const getDownloadsReleaseRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readDownloadsReleaseInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getDownloadsRelease }] = await Promise.all([
      import("./server/config.server"),
      import("./server/releaseDownloads"),
    ]);
    const { core } = await prepareConfig();
    return getDownloadsRelease(core, data);
  });

export const getReleaseDownloadsRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readReleaseDownloadsInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getReleaseDownloads }, { requireFeature }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/releaseDownloads"),
        import("./server/runtime.server"),
      ]);
    const { runtime } = await prepareConfig();
    return getReleaseDownloads(
      await requireFeature(runtime, "insightsAnalytics"),
      data,
    );
  });
