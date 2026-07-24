import {
  DatabasePluginInputError,
  type BundleEventRow,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import { createBundleRowFixture } from "./databaseTestFixtures";

type QueryTestState = DatabasePluginTestState<DatabasePlugin>;

type QueryOutcome<TValue> =
  | { readonly kind: "value"; readonly value: TValue }
  | { readonly error: unknown; readonly kind: "error" };

const expectExactOrUnsupported = async <TValue>(
  operation: Promise<TValue>,
  expected: TValue,
): Promise<void> => {
  const outcome = await operation.then<
    QueryOutcome<TValue>,
    QueryOutcome<TValue>
  >(
    (value) => ({ kind: "value", value }),
    (error: unknown) => ({ error, kind: "error" }),
  );
  if (outcome.kind === "value") {
    expect(outcome.value).toEqual(expected);
    return;
  }
  if (!(outcome.error instanceof DatabasePluginInputError)) {
    throw outcome.error;
  }
  expect(outcome.error.code).toBe("invalid-operation");
};

const createEvent = (
  id: string,
  installId: string,
  channel: string,
  receivedAtMs: number,
): BundleEventRow => ({
  id,
  type: "UPDATE_APPLIED",
  install_id: installId,
  user_id: null,
  username: null,
  from_bundle_id: "00000000-0000-0000-0000-000000000698",
  to_bundle_id: "00000000-0000-0000-0000-000000000699",
  platform: "ios",
  app_version: "1.0.0",
  channel,
  cohort: "stable",
  update_strategy: "fingerprint",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

const seedEvents = async (state: QueryTestState): Promise<void> => {
  const events = [
    createEvent(
      "00000000-0000-0000-0000-000000000601",
      "install-a",
      "production",
      100,
    ),
    createEvent(
      "00000000-0000-0000-0000-000000000602",
      "install-a",
      "production",
      200,
    ),
    createEvent(
      "00000000-0000-0000-0000-000000000603",
      "install-a",
      "preview",
      150,
    ),
    createEvent(
      "00000000-0000-0000-0000-000000000604",
      "install-b",
      "production",
      50,
    ),
  ];
  for (const event of events) {
    await state.getPlugin().create({ model: "bundle_events", data: event });
  }
};

export const registerDatabasePluginDistinctTests = (
  state: QueryTestState,
): void => {
  describe("distinct and ordering semantics", () => {
    it("counts one row per distinct field value when supported", async () => {
      // Given
      await seedEvents(state);

      // When
      const operation = state
        .getPlugin()
        .count({ model: "bundle_events", distinct: ["install_id"] });

      // Then
      await expectExactOrUnsupported(operation, 2);
    });

    it("counts one row per compound distinct tuple when supported", async () => {
      // Given
      await seedEvents(state);

      // When
      const operation = state.getPlugin().count({
        model: "bundle_events",
        distinct: ["install_id", "channel"],
      });

      // Then
      await expectExactOrUnsupported(operation, 3);
    });

    it("keeps the latest ordered row per distinct key when supported", async () => {
      // Given
      await seedEvents(state);

      // When
      const operation = state.getPlugin().findMany({
        model: "bundle_events",
        distinctOn: { fields: ["install_id"] },
        orderBy: [
          { field: "install_id", direction: "asc" },
          { field: "received_at_ms", direction: "desc" },
          { field: "id", direction: "asc" },
        ],
      });

      // Then
      const expectedIds = [
        "00000000-0000-0000-0000-000000000602",
        "00000000-0000-0000-0000-000000000604",
      ];
      const outcome = operation.then((rows) => rows.map(({ id }) => id));
      await expectExactOrUnsupported(outcome, expectedIds);
    });

    it("honors every ordering clause including the id tie-break", async () => {
      // Given
      const rows = [
        createBundleRowFixture("611", "preview"),
        createBundleRowFixture("612", "production"),
        createBundleRowFixture("613", "preview"),
      ];
      for (const row of rows) {
        await state.getPlugin().create({ model: "bundles", data: row });
      }

      // When
      const result = await state.getPlugin().findMany({
        model: "bundles",
        orderBy: [
          { field: "channel", direction: "asc" },
          { field: "id", direction: "desc" },
        ],
      });

      // Then
      expect(result.map(({ id }) => id)).toEqual([
        rows[2].id,
        rows[0].id,
        rows[1].id,
      ]);
    });
  });
};
