import { createServerFn } from "@tanstack/react-start";

import type { ConsoleFeatureSet } from "./console-features";

/** The features this console serves, for navigation and route guards. */
export const getConsoleFeaturesRpc = createServerFn({ method: "GET" }).handler(
  async (): Promise<ConsoleFeatureSet> => {
    const { prepareConfig } = await import("./server/config.server");
    const { runtime } = await prepareConfig();
    return { features: await runtime.features(), remote: runtime.remote };
  },
);
