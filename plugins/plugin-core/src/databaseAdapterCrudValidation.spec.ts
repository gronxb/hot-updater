import { describe, expect, it, vi } from "vitest";

import { createDatabaseAdapter } from "./createDatabaseAdapter";

const unimplemented = async (): Promise<never> => {
  throw new Error("unimplemented");
};

const createMethods = () => ({
  create: unimplemented,
  update: unimplemented,
  delete: unimplemented,
  count: unimplemented,
  findOne: unimplemented,
  findMany: unimplemented,
});

const bundleEventRow = {
  id: "01976b57-48d2-7e1b-8ee0-9cbf4b3f0001",
  type: "UPDATE_APPLIED" as const,
  install_id: "install-1",
  user_id: null,
  username: null,
  from_bundle_id: "bundle-0",
  to_bundle_id: "bundle-1",
  platform: "ios" as const,
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "appVersion" as const,
  fingerprint_hash: null,
  sdk_version: "0.37.0",
  received_at_ms: 1_725_000_000_000,
};

const unchangedBundleEventRow = {
  ...bundleEventRow,
  type: "UNCHANGED" as const,
  from_bundle_id: null,
  update_strategy: null,
};

describe("database adapter CRUD event validation", () => {
  it("accepts UNCHANGED rows with null transition fields", async () => {
    const adapter = createDatabaseAdapter({
      name: "event-memory",
      adapter: () => ({
        ...createMethods(),
        create: async (input) => input.data,
      }),
    });
    const createOperation: unknown = Reflect.get(adapter, "create");
    if (typeof createOperation !== "function") {
      throw new Error("Expected the adapter create operation.");
    }

    await expect(
      Reflect.apply(createOperation, adapter, [
        { model: "bundle_events", data: unchangedBundleEventRow },
      ]),
    ).resolves.toEqual(unchangedBundleEventRow);
  });

  it("rejects mixed UNCHANGED transition fields and unknown event types", async () => {
    const create = vi.fn(unimplemented);
    const adapter = createDatabaseAdapter({
      name: "event-memory",
      adapter: () => ({ ...createMethods(), create }),
    });
    const createOperation: unknown = Reflect.get(adapter, "create");
    if (typeof createOperation !== "function") {
      throw new Error("Expected the adapter create operation.");
    }
    const mixedFields: unknown = {
      ...unchangedBundleEventRow,
      from_bundle_id: "bundle-0",
    };
    const unknownType: unknown = {
      ...unchangedBundleEventRow,
      type: "UNKNOWN",
    };

    await expect(
      Reflect.apply(createOperation, adapter, [
        { model: "bundle_events", data: mixedFields },
      ]),
    ).rejects.toMatchObject({ code: "invalid-data" });
    await expect(
      Reflect.apply(createOperation, adapter, [
        { model: "bundle_events", data: unknownType },
      ]),
    ).rejects.toMatchObject({ code: "invalid-data" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects mixed bundle event result rows", async () => {
    const adapter = createDatabaseAdapter({
      name: "event-memory",
      adapter: () => ({
        ...createMethods(),
        findOne: async () => ({
          ...unchangedBundleEventRow,
          update_strategy: "appVersion",
        }),
      }),
    });

    await expect(
      adapter.findOne({
        model: "bundle_events",
        where: [{ field: "id", value: unchangedBundleEventRow.id }],
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("rejects inconsistent bundle event projections", async () => {
    const projections = [
      {
        select: ["type", "from_bundle_id"],
        payload: '{"type":"UNCHANGED","from_bundle_id":"bundle-0"}',
      },
      {
        select: ["type", "update_strategy"],
        payload: '{"type":"UNCHANGED","update_strategy":"appVersion"}',
      },
      {
        select: ["type", "from_bundle_id"],
        payload: '{"type":"UPDATE_APPLIED","from_bundle_id":null}',
      },
      {
        select: ["type", "update_strategy"],
        payload: '{"type":"UPDATE_APPLIED","update_strategy":null}',
      },
    ] as const;
    let payload: string = projections[0].payload;
    const adapter = createDatabaseAdapter({
      name: "event-memory",
      adapter: () => ({
        ...createMethods(),
        findOne: async () => JSON.parse(payload),
      }),
    });
    const findOneOperation: unknown = Reflect.get(adapter, "findOne");
    if (typeof findOneOperation !== "function") {
      throw new Error("Expected the adapter findOne operation.");
    }

    for (const projection of projections) {
      payload = projection.payload;
      await expect(
        Reflect.apply(findOneOperation, adapter, [
          {
            model: "bundle_events",
            where: [{ field: "id", value: bundleEventRow.id }],
            select: projection.select,
          },
        ]),
      ).rejects.toMatchObject({ code: "invalid-result" });
    }
  });

  it("accepts valid partial bundle event projections", async () => {
    const projections = [
      {
        select: ["type", "from_bundle_id"],
        payload: '{"type":"UNCHANGED","from_bundle_id":null}',
      },
      {
        select: ["type", "update_strategy"],
        payload: '{"type":"UPDATE_APPLIED","update_strategy":"appVersion"}',
      },
      {
        select: ["type"],
        payload: '{"type":"RECOVERED"}',
      },
    ] as const;
    let payload: string = projections[0].payload;
    const adapter = createDatabaseAdapter({
      name: "event-memory",
      adapter: () => ({
        ...createMethods(),
        findOne: async () => JSON.parse(payload),
      }),
    });
    const findOneOperation: unknown = Reflect.get(adapter, "findOne");
    if (typeof findOneOperation !== "function") {
      throw new Error("Expected the adapter findOne operation.");
    }

    for (const projection of projections) {
      payload = projection.payload;
      await expect(
        Reflect.apply(findOneOperation, adapter, [
          {
            model: "bundle_events",
            where: [{ field: "id", value: bundleEventRow.id }],
            select: projection.select,
          },
        ]),
      ).resolves.toEqual(JSON.parse(projection.payload));
    }
  });
});
