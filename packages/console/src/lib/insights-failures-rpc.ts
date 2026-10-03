import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";
import { readFailureReportsInput } from "./insights-errors";
import { readUpdateFailuresInput } from "./insights-failures";

export const getUpdateFailuresRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readUpdateFailuresInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { getUpdateFailuresReport }, { requireFeature }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/updateFailures"),
        import("./server/runtime.server"),
      ]);
    const { runtime } = await prepareConfig();
    return getUpdateFailuresReport(
      await requireFeature(runtime, "insights"),
      data,
    );
  });

export const listFailureReportsRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(readFailureReportsInput)
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { listFailureReports }, { requireFeature }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/failureReports"),
        import("./server/runtime.server"),
      ]);
    const { runtime } = await prepareConfig();
    return listFailureReports(await requireFeature(runtime, "insights"), data);
  });
