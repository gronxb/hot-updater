import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  createKvAdapter,
  createMemoryAdapter,
  createSqlAdapter,
  type DatabaseAdapter,
  generateEngineSql,
  type NativeBuildRegistration,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { createMemoryKeyValueStore } from "@hot-updater/test-utils";
import { pgliteExecutor, sqliteExecutor } from "@hot-updater/test-utils/node";
import { afterEach, describe, expect, it } from "vitest";

import { createInProcessCoreApi } from "./inProcess.testFixtures";

/** Core's tables alone, as a database migrated for core creates them. */
const sql = (dialect: "postgresql" | "sqlite") => {
  const target = toolingTargetOf([]);
  return generateEngineSql(dialect, target.schema, target.settings);
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The adapters a store build mark runs on: memory, key-value, and SQL. */
const adapters: readonly [string, () => Promise<DatabaseAdapter>][] = [
  ["memory", async () => createMemoryAdapter()],
  [
    "key-value",
    async () => createKvAdapter({ store: createMemoryKeyValueStore() }),
  ],
  [
    "SQLite",
    async () => {
      const db = new DatabaseSync(":memory:");
      for (const statement of sql("sqlite")) db.exec(statement);
      cleanups.push(() => db.close());
      return createSqlAdapter({ executor: sqliteExecutor(db) });
    },
  ],
  [
    "PostgreSQL",
    async () => {
      const pglite = new PGlite();
      for (const statement of sql("postgresql")) await pglite.exec(statement);
      cleanups.push(() => pglite.close());
      return createSqlAdapter({ executor: pgliteExecutor(pglite) });
    },
  ],
];

const buildId = (n: number) =>
  `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const minBundleId = (n: number) =>
  `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const registration = (
  n: number,
  overrides: Partial<NativeBuildRegistration> = {},
): NativeBuildRegistration =>
  ({
    id: buildId(n),
    platform: "ios",
    channel: "production",
    fingerprintHash: "fingerprint-a",
    appVersion: null,
    minBundleId: minBundleId(n),
    gitCommitHash: null,
    buildKey: null,
    artifact: {
      kind: "ipa",
      storageUri: `storage://native-builds/ios/${buildId(n)}/App.ipa`,
      byteSize: 1_000 + n,
    },
    embeddedBundle: {
      manifestStorageUri: `storage://bundles/${minBundleId(n)}/manifest.json`,
      manifestFileHash: `manifest-hash-${n}`,
      assetBaseStorageUri: "storage://assets",
    },
    ...overrides,
  }) as NativeBuildRegistration;

const scope = {
  platform: "ios",
  channel: "production",
  fingerprintHash: "fingerprint-a",
  appVersion: null,
} as const;

describe.each(adapters)("the store build mark on %s", (_name, adapter) => {
  const setup = async () => createInProcessCoreApi(await adapter());
  const marksIn = async (core: Awaited<ReturnType<typeof setup>>) =>
    (await core.listNativeBuilds({ limit: 100 }))
      .filter(({ is_store_build }) => is_store_build)
      .map(({ id }) => id);

  it("reads back a sandbox build's URL scheme, and null for none", async () => {
    const core = await setup();
    const custom = await core.registerNativeBuild(
      registration(1, {
        channel: "sandbox-release",
        isSandbox: true,
        sandboxUrlScheme: "acme-preview",
      }),
    );
    await core.registerNativeBuild(
      registration(2, { channel: "sandbox-release", isSandbox: true }),
    );

    expect(custom.sandbox_url_scheme).toBe("acme-preview");
    expect((await core.getNativeBuild(buildId(1)))?.sandbox_url_scheme).toBe(
      "acme-preview",
    );
    expect(
      (await core.getNativeBuild(buildId(2)))?.sandbox_url_scheme,
    ).toBeNull();
  });

  it("registers every build with both booleans false, any number to a scope", async () => {
    const core = await setup();
    for (const n of [1, 2, 3]) await core.registerNativeBuild(registration(n));
    const sandbox = await core.registerNativeBuild(
      registration(4, { channel: "sandbox-release", isSandbox: true }),
    );

    expect(
      (await core.listNativeBuilds({ limit: 100 }))
        .map(({ id, is_store_build, is_sandbox }) => [
          id,
          is_store_build,
          is_sandbox,
        ])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      [buildId(1), false, false],
      [buildId(2), false, false],
      [buildId(3), false, false],
      [buildId(4), false, true],
    ]);
    expect(sandbox).toMatchObject({ is_store_build: false, is_sandbox: true });
  });

  it("leaves one mark when first marks race, and when replacements race", async () => {
    const core = await setup();
    for (const n of [1, 2, 3]) await core.registerNativeBuild(registration(n));

    const first = await Promise.all(
      [1, 2, 3].map((n) =>
        core.markNativeBuild(buildId(n), { storeBuild: true }),
      ),
    );
    expect(first.map((result) => result?.nativeBuild.is_store_build)).toEqual([
      true,
      true,
      true,
    ]);
    expect(await marksIn(core)).toHaveLength(1);

    const replaced = await Promise.all(
      [3, 1, 2, 3].map((n) =>
        core.markNativeBuild(buildId(n), { storeBuild: true }),
      ),
    );
    expect(replaced.every((result) => result?.nativeBuild.is_store_build)).toBe(
      true,
    );
    const marks = await marksIn(core);
    expect(marks).toHaveLength(1);
    expect(
      await core.findNativeBuild(scope, { storeBuild: true }),
    ).toMatchObject({ id: marks[0], is_store_build: true });

    await core.markNativeBuild(marks[0]!, { storeBuild: false });
    expect(await marksIn(core)).toEqual([]);
    expect(await core.findNativeBuild(scope, { storeBuild: true })).toBeNull();
  });
});

describe("a native build row written before sandbox_url_scheme", () => {
  /**
   * A key-value store under an RC-era writer, which knew no
   * `sandbox_url_scheme`: every row and index copy it stores lacks the field,
   * as an item DynamoDB, Firestore or Cosmos DB holds from then does.
   */
  const rcEraStore = () => {
    const store = createMemoryKeyValueStore();
    let dropped = 0;
    const withoutColumn = (value: Readonly<Record<string, unknown>>) => {
      if (!("sandbox_url_scheme" in value)) return value;
      dropped += 1;
      const { sandbox_url_scheme: _dropped, ...rest } = value;
      return rest;
    };
    return {
      ...store,
      /** How many stored items the field was left out of. */
      dropped: () => dropped,
      write: ((ops) =>
        store.write(
          ops.map((op) =>
            op.type === "put"
              ? { ...op, value: withoutColumn(op.value) }
              : op.type === "add" && op.init !== undefined
                ? { ...op, init: withoutColumn(op.init) }
                : op,
          ) as typeof ops,
        )) as typeof store.write,
    };
  };

  it("reads back with no URL scheme, by its ID and by its scope", async () => {
    const store = rcEraStore();
    const core = createInProcessCoreApi(createKvAdapter({ store }));
    await core.registerNativeBuild(
      registration(1, {
        channel: "sandbox-release",
        isSandbox: true,
        sandboxUrlScheme: "acme-preview",
      }),
    );
    // The row and its index copies hold no field at all, not a null.
    expect(store.dropped()).toBeGreaterThan(0);

    const byId = await core.getNativeBuild(buildId(1));
    expect(byId).toMatchObject({ is_sandbox: true, sandbox_url_scheme: null });
    expect(byId).toHaveProperty("sandbox_url_scheme", null);
    expect(
      await core.findNativeBuild({ ...scope, channel: "sandbox-release" }),
    ).toHaveProperty("sandbox_url_scheme", null);
    expect(
      (await core.listNativeBuilds({ limit: 10 })).map(
        ({ sandbox_url_scheme }) => sandbox_url_scheme,
      ),
    ).toEqual([null]);
  });
});

describe.each(adapters)("the export method on %s", (_name, adapter) => {
  /** A core whose clock reads `clock.ms`, so registration order is the test's. */
  const setup = async () => {
    const clock = { ms: 1_000 };
    const core = createInProcessCoreApi(await adapter(), {
      now: () => clock.ms,
    });
    const register = async (
      n: number,
      ms: number,
      overrides: Partial<NativeBuildRegistration> = {},
    ) => {
      clock.ms = ms;
      return core.registerNativeBuild(registration(n, overrides));
    };
    return { core, clock, register };
  };
  it("records an .ipa's export method, and null when it has none", async () => {
    const { core, register } = await setup();
    const adHoc = await register(1, 1_000, { exportMethod: "ad-hoc" });
    await register(2, 2_000);

    expect(adHoc.export_method).toBe("ad-hoc");
    expect((await core.getNativeBuild(buildId(1)))?.export_method).toBe(
      "ad-hoc",
    );
    expect((await core.getNativeBuild(buildId(2)))?.export_method).toBeNull();
    await expect(
      register(3, 3_000, {
        exportMethod: "ad-hoc",
        artifact: {
          kind: "app",
          storageUri: "storage://native-builds/ios/3/App.app.zip",
          byteSize: 1,
        },
      }),
    ).rejects.toThrow("exportMethod is an .ipa's");
  });
});

describe.each(adapters)(
  "a native build read through a key on %s",
  (_name, adapter) => {
    it("ends at that key, either way, past `after` or from the edge", async () => {
      const core = createInProcessCoreApi(await adapter());
      for (const n of [1, 2, 3, 4, 5])
        await core.registerNativeBuild(registration(n));
      const ids = async (input: Parameters<typeof core.listNativeBuilds>[0]) =>
        (await core.listNativeBuilds(input)).map(({ id }) => id);

      expect(
        await ids({
          order: "desc",
          after: buildId(5),
          through: buildId(3),
          limit: 10,
        }),
      ).toEqual([buildId(4), buildId(3)]);
      expect(
        await ids({ order: "desc", through: buildId(4), limit: 10 }),
      ).toEqual([buildId(5), buildId(4)]);
      expect(
        await ids({
          order: "asc",
          after: buildId(1),
          through: buildId(3),
          limit: 10,
        }),
      ).toEqual([buildId(2), buildId(3)]);
      // The limit still ends a read first.
      expect(
        await ids({ order: "desc", through: buildId(1), limit: 2 }),
      ).toEqual([buildId(5), buildId(4)]);
    });
  },
);

describe.each(adapters)(
  "the artifact's own app version on %s",
  (_name, adapter) => {
    it("records it on a build of either strategy, and null without one", async () => {
      const core = createInProcessCoreApi(await adapter());
      const fingerprint = await core.registerNativeBuild(
        registration(1, { nativeAppVersion: "1.6.0" }),
      );
      await core.registerNativeBuild(
        registration(2, {
          fingerprintHash: null,
          appVersion: "1.4.2",
          nativeAppVersion: "1.4.2",
        }),
      );
      await core.registerNativeBuild(registration(3));

      // A fingerprint build keeps no OTA app version, and has its own.
      expect(fingerprint).toMatchObject({
        app_version: null,
        native_app_version: "1.6.0",
      });
      expect(await core.getNativeBuild(buildId(1))).toMatchObject({
        app_version: null,
        native_app_version: "1.6.0",
      });
      expect(await core.findNativeBuild(scope)).toMatchObject({
        id: buildId(3),
        native_app_version: null,
      });
      expect(
        (await core.listNativeBuilds({ order: "asc", limit: 10 })).map(
          ({ app_version, native_app_version }) => [
            app_version,
            native_app_version,
          ],
        ),
      ).toEqual([
        [null, "1.6.0"],
        ["1.4.2", "1.4.2"],
        [null, null],
      ]);
      await expect(
        core.registerNativeBuild(registration(4, { nativeAppVersion: " " })),
      ).rejects.toThrow("nativeAppVersion must be the artifact's app version");
    });
  },
);

describe("a native build row written before native_app_version", () => {
  it("reads back with none from a store whose rows lack the field", async () => {
    const store = createMemoryKeyValueStore();
    const core = createInProcessCoreApi(
      createKvAdapter({
        store: {
          ...store,
          write: ((ops) =>
            store.write(
              ops.map((op) => {
                const strip = (value: Readonly<Record<string, unknown>>) => {
                  const { native_app_version: _dropped, ...rest } = value;
                  return rest;
                };
                return op.type === "put"
                  ? { ...op, value: strip(op.value) }
                  : op.type === "add" && op.init !== undefined
                    ? { ...op, init: strip(op.init) }
                    : op;
              }) as typeof ops,
            )) as typeof store.write,
        },
      }),
    );
    await core.registerNativeBuild(
      registration(1, { nativeAppVersion: "1.6.0" }),
    );

    expect(await core.getNativeBuild(buildId(1))).toHaveProperty(
      "native_app_version",
      null,
    );
    expect(await core.findNativeBuild(scope)).toHaveProperty(
      "native_app_version",
      null,
    );
  });

  /** Core's tables as a 1.2.0 prerelease created them, without the column. */
  const rcEraSql = (dialect: "postgresql" | "sqlite") =>
    sql(dialect).map((statement) =>
      statement.replace(/"native_app_version" [^,]+, /, ""),
    );

  it("gives MySQL the column type its release notes' ALTER adds", () => {
    const target = toolingTargetOf([]);
    const table = generateEngineSql(
      "mysql",
      target.schema,
      target.settings,
    ).find((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS `native_builds`"),
    );
    expect(table).toContain(
      "`native_app_version` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin,",
    );
  });

  it.each([
    [
      "SQLite",
      async (alter: string) => {
        const db = new DatabaseSync(":memory:");
        for (const statement of rcEraSql("sqlite")) db.exec(statement);
        cleanups.push(() => db.close());
        expect(
          db.prepare(`PRAGMA table_info("native_builds")`).all(),
        ).not.toContainEqual(
          expect.objectContaining({ name: "native_app_version" }),
        );
        db.exec(alter);
        return createSqlAdapter({ executor: sqliteExecutor(db) });
      },
      `ALTER TABLE "native_builds" ADD COLUMN "native_app_version" TEXT;`,
    ],
    [
      "PostgreSQL",
      async (alter: string) => {
        const pglite = new PGlite();
        for (const statement of rcEraSql("postgresql")) {
          await pglite.exec(statement);
        }
        cleanups.push(() => pglite.close());
        await pglite.exec(alter);
        return createSqlAdapter({ executor: pgliteExecutor(pglite) });
      },
      `ALTER TABLE "native_builds" ADD COLUMN "native_app_version" text COLLATE "C";`,
    ],
  ] as const)(
    "takes the release notes' ALTER on a prerelease %s database",
    async (_name, open, alter) => {
      const adapter = await open(alter);
      const core = createInProcessCoreApi(adapter);
      await core.registerNativeBuild(registration(1));
      await core.registerNativeBuild(
        registration(2, { nativeAppVersion: "1.6.0" }),
      );
      expect(
        (await core.listNativeBuilds({ order: "asc", limit: 10 })).map(
          ({ native_app_version }) => native_app_version,
        ),
      ).toEqual([null, "1.6.0"]);
    },
  );
});
