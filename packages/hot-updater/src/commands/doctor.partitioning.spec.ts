import {
  createEngine,
  createEngineDatabase,
  createMemoryAdapter,
  type DatabaseAdapter,
  type HotUpdaterCoreApi,
  migrateCoreSchema,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  createBundleFixture,
  createReleaseCatalogTestStorage,
  setReleaseCatalogPartitioning,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { checkServerData } from "./doctor/serverData";

const COMMAND = "npx hot-updater db partition-catalogs --server-url <url>";

const setup = async (
  wrap: (a: DatabaseAdapter) => DatabaseAdapter = (a) => a,
) => {
  const raw = createMemoryAdapter();
  await migrateCoreSchema(raw, "memory");
  const adapter = wrap(raw);
  const server = createHotUpdater({
    clientAccess: "public",
    database: createEngineDatabase({ name: "memory", adapter }),
    storage: createReleaseCatalogTestStorage(),
  });
  const core = server.core as HotUpdaterCoreApi;
  const deploy = async (n: number, channel = "production") =>
    (
      await core.deploy([
        {
          bundle: createBundleFixture(String(n)),
          release: {
            channel,
            enabled: true,
            fingerprintHash: null,
            message: null,
            shouldForceUpdate: false,
            targetAppVersion: `${n}.0.0`,
          },
        },
      ])
    )[0]!.release!.scope_key;
  const enable = async () => {
    const response = await server.handlers.admin(
      new Request("http://localhost/release-catalog-partitioning", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
  };
  const check = () => checkServerData(core, { partitionCommand: COMMAND });
  return { raw, core, deploy, enable, check };
};

describe("doctor's partitioning report", () => {
  it("warns that partitioning is available but off, with the command, and sets nothing", async () => {
    const env = await setup();
    await env.deploy(1);
    const status = await env.check();
    expect(status.partitioning).toEqual({
      switch: "off",
      table: "present",
      compactScopes: 0,
    });
    expect(status.issues).toEqual([
      {
        type: "warning",
        code: "RELEASE_CATALOG_PARTITIONING_OFF",
        message:
          "Release catalogs are single-row, so each scope is limited to 256 KB.",
        resolution:
          "Once every server runs 1.2.0, partition them. It can't be undone:",
        commands: [COMMAND],
      },
    ]);
    expect(await env.core.getReleaseCatalogPartitioning()).toMatchObject({
      switch: "off",
    });
  });

  it("after enable, reports scopes still single-row as information, from each scope's own row", async () => {
    const env = await setup();
    const production = await env.deploy(1);
    await env.deploy(2, "beta");
    await env.enable();
    // A stray row in the partitions table, such as an interrupted probe's
    // or an abandoned stage, proves nothing about any scope.
    await createEngine({ name: "memory", adapter: env.raw }).core.transaction(
      async (tx) => {
        tx.create("release_catalog_partitions", {
          scope_key: production,
          epoch: "0abc",
          lower_key: "a",
          generation: 1,
          payload: "{}",
          partition_hash: "x",
          byte_size: 2,
        });
      },
    );
    const before = await env.check();
    expect(before.issues).toEqual([]);
    expect(before.partitioning).toEqual({
      switch: "on",
      table: "present",
      compactScopes: 2,
    });
    expect(before.scopes.map(({ layout }) => layout)).toEqual([
      "compact",
      "compact",
    ]);

    // The scope's next write converts it.
    await env.deploy(3);
    const after = await env.check();
    expect(after.issues).toEqual([]);
    expect(after.partitioning?.compactScopes).toBe(1);
    expect(
      after.scopes.find(({ scopeKey }) => scopeKey === production)?.layout,
    ).toBe("partitioned");
  });

  it("warns when partitioned scopes exist but the switch was deleted by hand", async () => {
    const env = await setup();
    await env.enable();
    await env.deploy(1);
    await setReleaseCatalogPartitioning(env.raw, "off");
    const status = await env.check();
    expect(status.issues).toEqual([
      expect.objectContaining({
        type: "warning",
        code: "RELEASE_CATALOG_PARTITIONING_SWITCH_MISSING",
        message:
          "1 scope is partitioned, but partitioning is off, so other scopes stay single-row, each limited to 256 KB.",
        commands: [COMMAND],
      }),
    ]);
  });

  it.each([
    ["off", "warning"],
    ["on", "error"],
  ] as const)(
    "reports a table the server can't read, with the switch %s, as a %s",
    async (state, type) => {
      const refusing = (base: DatabaseAdapter): DatabaseAdapter => ({
        ...base,
        async query(...args: Parameters<DatabaseAdapter["query"]>) {
          if (args[0].name === "release_catalog_partitions") {
            throw new Error("no such table: release_catalog_partitions");
          }
          return base.query(...args);
        },
      });
      const env = await setup(refusing);
      if (state === "on") await setReleaseCatalogPartitioning(env.raw, "on");
      const status = await env.check();
      expect(status.partitioning).toMatchObject({
        switch: state,
        table: "missing",
      });
      expect(status.issues).toEqual([
        expect.objectContaining({
          type,
          code: "RELEASE_CATALOG_PARTITIONS_MISSING",
        }),
      ]);
    },
  );

  it("reports nothing about partitioning for a server before 1.2.0", async () => {
    const env = await setup();
    const older: HotUpdaterCoreApi = {
      ...env.core,
      getReleaseCatalogPartitioning: async () => {
        throw Object.assign(
          new Error("no release catalog partitioning route"),
          {
            status: 404,
          },
        );
      },
    };
    const status = await checkServerData(older, { partitionCommand: COMMAND });
    expect(status.partitioning).toBeUndefined();
    expect(status.issues).toEqual([]);
  });
});
