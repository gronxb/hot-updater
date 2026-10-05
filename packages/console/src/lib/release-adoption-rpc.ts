import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";
import {
  readAdoptionReleaseInput,
  readAdoptionReleasesInput,
  readBundleEventsInput,
} from "./release-adoption";

export const listAdoptionReleasesRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readAdoptionReleasesInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { listAdoptionReleases }] = await Promise.all([
      import("./server/config.server"),
      import("./server/releaseAdoption"),
    ]);
    const { core } = await prepareConfig();
    return listAdoptionReleases(core, data);
  });

export const getAdoptionReleaseRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readAdoptionReleaseInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getAdoptionRelease }] = await Promise.all([
      import("./server/config.server"),
      import("./server/releaseAdoption"),
    ]);
    const { core } = await prepareConfig();
    return getAdoptionRelease(core, data);
  });

export const getBundleEventsRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readBundleEventsInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getBundleEvents }, { requireFeature }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/releaseAdoption"),
        import("./server/runtime.server"),
      ]);
    const { runtime } = await prepareConfig();
    return getBundleEvents(
      await requireFeature(runtime, "insightsAnalytics"),
      data,
    );
  });
