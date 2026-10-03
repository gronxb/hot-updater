import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";
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
