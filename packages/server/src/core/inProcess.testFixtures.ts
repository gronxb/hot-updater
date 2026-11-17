import { createEngine, type DatabaseAdapter } from "@hot-updater/plugin-core";

import { createCoreApi, type CoreApi, type CoreApiOptions } from "./api";

/** Core's API on an adapter, without plugins or storage: what core's specs run on. */
export const createInProcessCoreApi = (
  adapter: DatabaseAdapter,
  options: CoreApiOptions = {},
): CoreApi =>
  createCoreApi(
    createEngine({ name: "in-process", adapter }).core,
    { resolveFileUrl: async () => null },
    options,
  );
