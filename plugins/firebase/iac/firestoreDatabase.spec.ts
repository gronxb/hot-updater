import { MissingInitInputsError } from "@hot-updater/cli-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async () => {
  const actual = await vi.importActual<typeof import("@hot-updater/cli-tools")>(
    "@hot-updater/cli-tools",
  );
  return {
    ...actual,
    p: {
      ...actual.p,
      log: { ...actual.p.log, warn: mocks.warn },
      select: mocks.select,
    },
  };
});

import {
  parseFirestoreDatabaseIds,
  resolveFirestoreDatabaseId,
} from "./firestoreDatabase";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseFirestoreDatabaseIds", () => {
  it("reads the IDs of the databases the Firestore API can use", () => {
    expect(
      parseFirestoreDatabaseIds([
        {
          name: "projects/demo-project/databases/(default)",
          type: "FIRESTORE_NATIVE",
        },
        {
          name: "projects/demo-project/databases/hot-updater",
          type: "FIRESTORE_NATIVE",
        },
        {
          name: "projects/demo-project/databases/legacy",
          type: "DATASTORE_MODE",
        },
        {
          name: "projects/demo-project/databases/mongo",
          type: "FIRESTORE_NATIVE",
          databaseEdition: "ENTERPRISE",
          firestoreDataAccessMode: "DATA_ACCESS_MODE_DISABLED",
        },
        {
          name: "projects/demo-project/databases/enterprise",
          type: "FIRESTORE_NATIVE",
          databaseEdition: "ENTERPRISE",
          firestoreDataAccessMode: "DATA_ACCESS_MODE_ENABLED",
        },
      ]),
    ).toEqual(["(default)", "hot-updater", "enterprise"]);
  });

  it("reads nothing from an unexpected response", () => {
    expect(parseFirestoreDatabaseIds({ databases: [] })).toEqual([]);
    expect(parseFirestoreDatabaseIds([null, { type: "x" }])).toEqual([]);
  });
});

describe("resolveFirestoreDatabaseId", () => {
  const databaseIds = ["(default)", "hot-updater", "other"];

  it("uses the saved database while the project has it", async () => {
    await expect(
      resolveFirestoreDatabaseId({
        databaseIds,
        nonInteractive: false,
        savedDatabaseId: "hot-updater",
      }),
    ).resolves.toBe("hot-updater");
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("uses the only database, named or not, without a prompt", async () => {
    await expect(
      resolveFirestoreDatabaseId({
        databaseIds: ["hot-updater"],
        nonInteractive: false,
      }),
    ).resolves.toBe("hot-updater");
    await expect(
      resolveFirestoreDatabaseId({
        databaseIds: ["hot-updater"],
        nonInteractive: true,
      }),
    ).resolves.toBe("hot-updater");
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("prompts among several databases with (default) selected", async () => {
    mocks.select.mockResolvedValue("other");

    await expect(
      resolveFirestoreDatabaseId({ databaseIds, nonInteractive: false }),
    ).resolves.toBe("other");
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "(default)",
        message: "Select a Firestore database",
        options: databaseIds.map((id) => ({ value: id, label: id })),
      }),
    );
  });

  it("prompts again when the saved database is gone", async () => {
    mocks.select.mockResolvedValue("hot-updater");

    await expect(
      resolveFirestoreDatabaseId({
        databaseIds,
        nonInteractive: false,
        savedDatabaseId: "deleted",
      }),
    ).resolves.toBe("hot-updater");
    expect(mocks.warn).toHaveBeenCalledWith(
      "Saved Firestore database deleted was not found. Select a database again.",
    );
  });

  it("keeps (default) without a saved database in non-interactive mode", async () => {
    await expect(
      resolveFirestoreDatabaseId({ databaseIds, nonInteractive: true }),
    ).resolves.toBe("(default)");
  });

  it.each([
    { databaseIds: ["hot-updater", "other"], savedDatabaseId: undefined },
    { databaseIds, savedDatabaseId: "deleted" },
  ])(
    "asks for HOT_UPDATER_FIREBASE_DATABASE_ID in non-interactive mode when it cannot choose: %o",
    async (inputs) => {
      const resolved = resolveFirestoreDatabaseId({
        ...inputs,
        nonInteractive: true,
      });

      await expect(resolved).rejects.toBeInstanceOf(MissingInitInputsError);
      await expect(resolved).rejects.toMatchObject({
        missingInputs: ["HOT_UPDATER_FIREBASE_DATABASE_ID"],
      });
    },
  );
});
