import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";

import { setupDatabaseAdapterConformanceSuite } from "./setupDatabaseAdapterConformanceSuite";

setupDatabaseAdapterConformanceSuite({
  name: "memory",
  maxOps: 25,
  createAdapter: async ({ tables, nativePageSize }) => {
    const adapter = createMemoryAdapter({ maxOps: 25, nativePageSize });
    await adapter.migrations?.apply(tables);
    return { adapter };
  },
});
