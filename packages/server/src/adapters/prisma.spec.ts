import { describe, expect, it } from "vitest";

import { setupDatabaseAdapterTestSuite } from "../../../test-utils/src/setupDatabaseAdapterTestSuite";
import { prismaAdapter } from "./prisma";
import { createPrismaTestHarness } from "./prismaTestClient";

const harness = createPrismaTestHarness();

setupDatabaseAdapterTestSuite({
  name: "prismaAdapter v2",
  capabilities: { getUpdateInfo: true, transaction: true },
  migrate: () => undefined,
  createAdapter: () =>
    prismaAdapter({ prisma: harness.client, provider: "postgresql" }),
  reset: () => harness.reset(),
  dispose: () => undefined,
});

describe("prismaAdapter capabilities", () => {
  it("returns a plugin object instead of a callable factory", () => {
    const adapter = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });

    expect(adapter).toBeTypeOf("object");
    expect(adapter.name).toBe("prisma");
    expect(adapter.adapterName).toBe("prisma");
    expect(adapter.provider).toBe("postgresql");
  });

  it("omits transaction when callback transactions are unavailable", () => {
    const { $transaction: _transaction, ...client } = harness.client;

    const adapter = prismaAdapter({ prisma: client, provider: "postgresql" });

    expect(adapter.transaction).toBeUndefined();
  });
});
