import {
  defineUniversalComponentSchema,
  type UniversalComponentDataAdapter,
  type UniversalComponentRow,
  type UniversalComponentSchema,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Awaitable<T> = Promise<T> | T;

export const syntheticMigrationVersions = {
  latest: "2",
  legacy: "1",
} as const;

export const syntheticMigrationLegacyEvidence = {
  fresh: "0.0.0",
  version1: "0.1.0",
  version2: "0.2.0",
} as const;

const migrationColumnsV1 = [
  { name: "id", type: "uuid", primaryKey: true },
  { name: "recorded_at_ms", type: "integer" },
  { name: "action", type: "string" },
  { name: "actor_id", type: "string" },
] as const;

const migrationColumnsV2 = [
  { name: "id", type: "uuid", primaryKey: true },
  { name: "recorded_at_ms", type: "integer" },
  { name: "action", type: "string" },
  { name: "actor_id", type: "string", nullable: true },
] as const;

export const syntheticAuditLogMigrationSchema = defineUniversalComponentSchema({
  id: "audit-history",
  unmarked: {
    adopt: [
      {
        version: syntheticMigrationVersions.legacy,
        when: [syntheticMigrationLegacyEvidence.version1],
      },
      {
        version: syntheticMigrationVersions.latest,
        when: [
          null,
          syntheticMigrationLegacyEvidence.fresh,
          syntheticMigrationLegacyEvidence.version1,
          syntheticMigrationLegacyEvidence.version2,
        ],
      },
    ],
    createWhen: [null, syntheticMigrationLegacyEvidence.fresh],
    discriminatorKey: "version",
    knownValues: [
      null,
      syntheticMigrationLegacyEvidence.fresh,
      syntheticMigrationLegacyEvidence.version1,
      syntheticMigrationLegacyEvidence.version2,
    ],
  },
  versions: [
    {
      version: syntheticMigrationVersions.legacy,
      tables: [
        {
          name: "audit_history_records",
          columns: migrationColumnsV1,
          checks: [
            {
              name: "audit_history_action_non_empty",
              expression: { column: "action", op: "non-empty" },
            },
            {
              enforcement: "validation",
              name: "audit_history_action_allowed",
              expression: {
                column: "action",
                op: "in",
                values: ["configuration-read", "anonymous-read"],
              },
            },
            {
              name: "audit_history_time_v1",
              expression: {
                expressions: [
                  { column: "recorded_at_ms", op: "integer" },
                  { column: "recorded_at_ms", op: "gte", value: 0 },
                ],
                op: "all",
              },
            },
            {
              name: "audit_history_actor_v1",
              expression: { column: "actor_id", op: "non-empty" },
            },
          ],
          indexes: [
            {
              name: "audit_history_chronological_v1_idx",
              columns: ["recorded_at_ms", "id"],
            },
          ],
        },
      ],
      orderedScans: [
        {
          name: "chronological",
          table: "audit_history_records",
          columns: ["recorded_at_ms", "id"],
        },
      ],
    },
    {
      version: syntheticMigrationVersions.latest,
      tables: [
        {
          name: "audit_history_records",
          columns: migrationColumnsV2,
          checks: [
            {
              name: "audit_history_action_non_empty",
              expression: { column: "action", op: "non-empty" },
            },
            {
              enforcement: "validation",
              name: "audit_history_action_allowed",
              expression: {
                column: "action",
                op: "in",
                values: ["configuration-read", "anonymous-read"],
              },
            },
            {
              name: "audit_history_time_v2",
              expression: {
                expressions: [
                  { column: "recorded_at_ms", op: "integer" },
                  { column: "recorded_at_ms", op: "gte", value: 0 },
                ],
                op: "all",
              },
            },
            {
              name: "audit_history_actor_v2",
              expression: {
                expressions: [
                  { column: "actor_id", op: "is-null" },
                  { column: "actor_id", op: "non-empty" },
                ],
                op: "any",
              },
            },
          ],
          indexes: [
            {
              name: "audit_history_chronological_v2_idx",
              columns: ["recorded_at_ms", "id"],
            },
          ],
        },
      ],
      orderedScans: [
        {
          name: "chronological",
          table: "audit_history_records",
          columns: ["recorded_at_ms", "id"],
        },
      ],
    },
  ],
});

export const syntheticMigrationV1Row: UniversalComponentRow = {
  action: "configuration-read",
  actor_id: "actor-1",
  id: "00000000-0000-4000-8000-000000000001",
  recorded_at_ms: 1,
};

export const syntheticMigrationV2Row: UniversalComponentRow = {
  action: "anonymous-read",
  actor_id: null,
  id: "00000000-0000-4000-8000-000000000002",
  recorded_at_ms: 2,
};

export const syntheticMigrationCorruptRow = {
  action: "configuration-read",
  actor_id: "actor-corrupt",
  id: "00000000-0000-4000-8000-000000000003",
  recorded_at_ms: -1,
} as const;

export const syntheticMigrationValidationOnlyCorruptRow = {
  action: "forbidden-action",
  actor_id: "actor-validation-corrupt",
  id: "00000000-0000-4000-8000-000000000004",
  recorded_at_ms: 4,
} as const;

export type SyntheticMigrationPhysicalState =
  | "absent"
  | "drift"
  | "version-1"
  | "version-2";

export type SyntheticUniversalComponentMigrationState = {
  readonly componentVersion: unknown;
  readonly legacyVersion: unknown;
  readonly physicalState: SyntheticMigrationPhysicalState;
  readonly rows: readonly unknown[];
};

export type UniversalComponentMigrationMutationCounts = {
  readonly markerWrites: number;
  readonly physicalWrites: number;
  readonly rowWrites: number;
};

export type UniversalComponentMigrationTestHarness = {
  readonly adapter: UniversalComponentDataAdapter;
  dispose?(): Awaitable<void>;
  failNextMarkerWrite?(): Awaitable<void>;
  inspect(
    schema: UniversalComponentSchema,
  ): Awaitable<SyntheticUniversalComponentMigrationState>;
  mutationCounts?(): Awaitable<UniversalComponentMigrationMutationCounts>;
  seed(
    schema: UniversalComponentSchema,
    state: SyntheticUniversalComponentMigrationState,
  ): Awaitable<void>;
};

export type UniversalComponentMigrationTestSuiteOptions = {
  readonly createHarness: () => Awaitable<UniversalComponentMigrationTestHarness>;
  readonly migrate?: (
    adapter: UniversalComponentDataAdapter,
    schema: UniversalComponentSchema,
  ) => Awaitable<unknown>;
  readonly name: string;
  /** Enables generic artifact metadata assertions for offline migrations. */
  readonly supportsArtifacts?: boolean;
  /** Enables the marker-write interruption case for instrumentable adapters. */
  readonly supportsMarkerWriteFailure?: boolean;
};

const state = (
  input: Partial<SyntheticUniversalComponentMigrationState> &
    Pick<SyntheticUniversalComponentMigrationState, "physicalState">,
): SyntheticUniversalComponentMigrationState => ({
  componentVersion: null,
  legacyVersion: syntheticMigrationLegacyEvidence.fresh,
  rows: [],
  ...input,
});

const migrationFailure = async (run: () => Awaitable<unknown>) => {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
};

export const setupUniversalComponentMigrationTestSuite = (
  options: UniversalComponentMigrationTestSuiteOptions,
): void => {
  describe(options.name, () => {
    let harness: UniversalComponentMigrationTestHarness | undefined;

    const getHarness = (): UniversalComponentMigrationTestHarness => {
      if (harness === undefined) {
        throw new TypeError(
          "The universal component migration harness is unavailable outside the test lifecycle.",
        );
      }
      return harness;
    };

    const migrate = async (): Promise<void> => {
      const current = getHarness();
      if (options.migrate !== undefined) {
        await options.migrate(
          current.adapter,
          syntheticAuditLogMigrationSchema,
        );
        return;
      }
      if (current.adapter.migrate === undefined) {
        throw new TypeError(
          `${options.name} must provide a migration hook or adapter.migrate().`,
        );
      }
      await current.adapter.migrate(syntheticAuditLogMigrationSchema);
    };

    const seed = async (
      initial: SyntheticUniversalComponentMigrationState,
    ): Promise<void> => {
      await getHarness().seed(syntheticAuditLogMigrationSchema, initial);
    };

    const inspect =
      async (): Promise<SyntheticUniversalComponentMigrationState> =>
        await getHarness().inspect(syntheticAuditLogMigrationSchema);

    beforeEach(async () => {
      harness = await options.createHarness();
    });

    afterEach(async () => {
      await harness?.dispose?.();
      harness = undefined;
    });

    if (options.supportsArtifacts) {
      it("labels every generated migration artifact with target version 2", () => {
        const artifacts = getHarness().adapter.artifacts?.(
          syntheticAuditLogMigrationSchema,
        );
        if (artifacts === undefined || artifacts.length === 0) {
          throw new TypeError(
            `${options.name} declares artifact support without artifacts.`,
          );
        }

        expect(new Set(artifacts.map(({ path }) => path)).size).toBe(
          artifacts.length,
        );
        for (const artifact of artifacts) {
          expect(artifact.contents.length).toBeGreaterThan(0);
          expect(artifact.path.length).toBeGreaterThan(0);
          expect(artifact.targetVersion).toBe(
            syntheticMigrationVersions.latest,
          );
        }
      });
    }

    it.each([null, syntheticMigrationLegacyEvidence.fresh])(
      "creates a fresh version 2 schema with legacy evidence %s before recording its marker",
      async (legacyVersion) => {
        await seed(state({ legacyVersion, physicalState: "absent" }));

        await migrate();

        await expect(inspect()).resolves.toEqual(
          state({
            componentVersion: "2",
            legacyVersion,
            physicalState: "version-2",
          }),
        );
      },
    );

    it("migrates an exact unmarked version 1 shape without losing rows", async () => {
      await seed(
        state({
          legacyVersion: syntheticMigrationLegacyEvidence.version1,
          physicalState: "version-1",
          rows: [syntheticMigrationV1Row],
        }),
      );

      await migrate();

      await expect(inspect()).resolves.toEqual(
        state({
          componentVersion: "2",
          legacyVersion: syntheticMigrationLegacyEvidence.version1,
          physicalState: "version-2",
          rows: [syntheticMigrationV1Row],
        }),
      );
    });

    it.each([
      null,
      syntheticMigrationLegacyEvidence.fresh,
      syntheticMigrationLegacyEvidence.version1,
      syntheticMigrationLegacyEvidence.version2,
    ])(
      "adopts an exact unmarked version 2 shape with legacy evidence %s without changing rows",
      async (legacyVersion) => {
        const initial = state({
          legacyVersion,
          physicalState: "version-2",
          rows: [syntheticMigrationV2Row],
        });
        await seed(initial);
        const beforeCounts = await getHarness().mutationCounts?.();

        await migrate();

        await expect(inspect()).resolves.toEqual({
          ...initial,
          componentVersion: "2",
        });
        const afterCounts = await getHarness().mutationCounts?.();
        if (beforeCounts !== undefined && afterCounts !== undefined) {
          expect(afterCounts.physicalWrites).toBe(beforeCounts.physicalWrites);
          expect(afterCounts.rowWrites).toBe(beforeCounts.rowWrites);
        }
      },
    );

    it("recovers when version 2 is physical but marker 1 was not advanced", async () => {
      const initial = state({
        componentVersion: "1",
        legacyVersion: syntheticMigrationLegacyEvidence.version1,
        physicalState: "version-2",
        rows: [syntheticMigrationV1Row],
      });
      await seed(initial);

      await migrate();

      await expect(inspect()).resolves.toEqual({
        ...initial,
        componentVersion: "2",
      });
    });

    it("revalidates an exact marked version 2 without rewriting it", async () => {
      const initial = state({
        componentVersion: "2",
        legacyVersion: syntheticMigrationLegacyEvidence.version2,
        physicalState: "version-2",
        rows: [syntheticMigrationV2Row],
      });
      await seed(initial);
      const beforeCounts = await getHarness().mutationCounts?.();

      await migrate();

      await expect(inspect()).resolves.toEqual(initial);
      const afterCounts = await getHarness().mutationCounts?.();
      if (beforeCounts !== undefined && afterCounts !== undefined) {
        expect(afterCounts).toEqual(beforeCounts);
      }
    });

    it.each([null, "1", "2"])(
      "fails closed on physical drift with marker %s",
      async (componentVersion) => {
        const initial = state({
          componentVersion,
          legacyVersion: syntheticMigrationLegacyEvidence.version1,
          physicalState: "drift",
          rows: [syntheticMigrationV1Row],
        });
        await seed(initial);

        await migrationFailure(migrate);

        await expect(inspect()).resolves.toEqual(initial);
      },
    );

    it.each([
      {
        caseName:
          "with a storage-check violation during a version 1 transition",
        initial: state({
          legacyVersion: syntheticMigrationLegacyEvidence.version1,
          physicalState: "version-1",
          rows: [syntheticMigrationCorruptRow],
        }),
      },
      {
        caseName:
          "with a storage-check violation during unmarked version 2 adoption",
        initial: state({
          legacyVersion: syntheticMigrationLegacyEvidence.version2,
          physicalState: "version-2",
          rows: [syntheticMigrationCorruptRow],
        }),
      },
      {
        caseName:
          "with a storage-check violation while revalidating marked version 2",
        initial: state({
          componentVersion: "2",
          legacyVersion: syntheticMigrationLegacyEvidence.version2,
          physicalState: "version-2",
          rows: [syntheticMigrationCorruptRow],
        }),
      },
      {
        caseName:
          "with a validation-only violation during a version 1 transition",
        initial: state({
          legacyVersion: syntheticMigrationLegacyEvidence.version1,
          physicalState: "version-1",
          rows: [syntheticMigrationValidationOnlyCorruptRow],
        }),
      },
      {
        caseName:
          "with a validation-only violation during unmarked version 2 adoption",
        initial: state({
          legacyVersion: syntheticMigrationLegacyEvidence.version2,
          physicalState: "version-2",
          rows: [syntheticMigrationValidationOnlyCorruptRow],
        }),
      },
      {
        caseName:
          "with a validation-only violation while revalidating marked version 2",
        initial: state({
          componentVersion: "2",
          legacyVersion: syntheticMigrationLegacyEvidence.version2,
          physicalState: "version-2",
          rows: [syntheticMigrationValidationOnlyCorruptRow],
        }),
      },
    ])(
      "rejects corrupt stored rows $caseName before changing the marker",
      async ({ initial }) => {
        await seed(initial);

        await migrationFailure(migrate);

        const after = await inspect();
        expect(after.componentVersion).toEqual(initial.componentVersion);
        expect(after.legacyVersion).toEqual(initial.legacyVersion);
        expect(after.rows).toEqual(initial.rows);
        expect(after.physicalState).not.toBe("drift");
        if (initial.physicalState === "version-2") {
          expect(after.physicalState).toBe("version-2");
        }
      },
    );

    it.each([
      ...[
        syntheticMigrationLegacyEvidence.version1,
        syntheticMigrationLegacyEvidence.version2,
      ].map((legacyVersion) => ({
        caseName: `physical absence with create-disallowed evidence ${legacyVersion}`,
        initial: state({ legacyVersion, physicalState: "absent" }),
      })),
      ...[
        null,
        syntheticMigrationLegacyEvidence.fresh,
        syntheticMigrationLegacyEvidence.version2,
      ].map((legacyVersion) => ({
        caseName: `unmarked version 1 with incompatible evidence ${String(legacyVersion)}`,
        initial: state({
          legacyVersion,
          physicalState: "version-1",
          rows: [syntheticMigrationV1Row],
        }),
      })),
    ])("rejects $caseName without changing state", async ({ initial }) => {
      await seed(initial);

      await migrationFailure(migrate);

      await expect(inspect()).resolves.toEqual(initial);
    });

    it.each([
      {
        caseName: "a future component marker",
        initial: state({
          componentVersion: "999",
          physicalState: "version-2",
          rows: [syntheticMigrationV2Row],
        }),
      },
      {
        caseName: "a corrupt component marker",
        initial: state({
          componentVersion: { value: "2" },
          physicalState: "version-2",
          rows: [syntheticMigrationV2Row],
        }),
      },
      {
        caseName: "future legacy evidence",
        initial: state({
          legacyVersion: "999.0.0",
          physicalState: "version-2",
          rows: [syntheticMigrationV2Row],
        }),
      },
    ])("rejects $caseName before mutation", async ({ initial }) => {
      await seed(initial);

      await migrationFailure(migrate);

      await expect(inspect()).resolves.toEqual(initial);
    });

    if (options.supportsMarkerWriteFailure) {
      it("keeps the old marker when marker writing fails and converges on retry", async () => {
        const failNextMarkerWrite = getHarness().failNextMarkerWrite;
        if (failNextMarkerWrite === undefined) {
          throw new TypeError(
            `${options.name} declares marker-write failure support without a harness hook.`,
          );
        }
        const initial = state({
          componentVersion: "1",
          legacyVersion: syntheticMigrationLegacyEvidence.version1,
          physicalState: "version-1",
          rows: [syntheticMigrationV1Row],
        });
        await seed(initial);
        await failNextMarkerWrite.call(getHarness());

        await migrationFailure(migrate);

        const interrupted = await inspect();
        expect(interrupted.componentVersion).toBe("1");
        expect(interrupted.physicalState).not.toBe("drift");
        expect(interrupted.rows).toEqual(initial.rows);

        await migrate();

        await expect(inspect()).resolves.toEqual({
          ...initial,
          componentVersion: "2",
          physicalState: "version-2",
        });
      });
    }

    it("is idempotent after reaching version 2", async () => {
      await seed(state({ physicalState: "absent" }));
      await migrate();
      const migrated = await inspect();
      const beforeCounts = await getHarness().mutationCounts?.();

      await migrate();

      await expect(inspect()).resolves.toEqual(migrated);
      const afterCounts = await getHarness().mutationCounts?.();
      if (beforeCounts !== undefined && afterCounts !== undefined) {
        expect(afterCounts).toEqual(beforeCounts);
      }
    });
  });
};
