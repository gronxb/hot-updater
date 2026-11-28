import { HotUpdaterSchemaMigrationRequiredError } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", () => ({
  p: { log: { error: vi.fn() } },
}));
vi.mock("./exitWhenFlushed", () => ({
  exitWhenFlushed: vi.fn(() => Promise.resolve()),
}));

import { p } from "@hot-updater/cli-tools";

import { exitWhenFlushed } from "./exitWhenFlushed";
import { endAtSchemaFence, isSchemaFenceRefusal } from "./schemaFenceRefusal";

const newerDatabase = () =>
  new HotUpdaterSchemaMigrationRequiredError("kysely", undefined, {
    key: "schema.core",
    expected: "1.0.0",
    found: "1.3.0",
  });

afterEach(() => {
  vi.clearAllMocks();
});

describe("isSchemaFenceRefusal", () => {
  it("recognizes the fence's error, from this or another copy of plugin-core, and nothing else", () => {
    expect(isSchemaFenceRefusal(newerDatabase())).toBe(true);
    expect(
      isSchemaFenceRefusal(
        Object.assign(new Error("copy"), {
          name: "HotUpdaterSchemaMigrationRequiredError",
        }),
      ),
    ).toBe(true);
    expect(isSchemaFenceRefusal(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(isSchemaFenceRefusal("HotUpdaterSchemaMigrationRequiredError")).toBe(
      false,
    );
  });
});

describe("endAtSchemaFence", () => {
  it("prints the fence's message as one line on stderr and exits 1", async () => {
    await endAtSchemaFence(newerDatabase());

    expect(p.log.error).toHaveBeenCalledExactlyOnceWith(
      'Hot Updater schema setting "schema.core" for kysely is "1.3.0"; expected "1.0.0". The database was migrated by Hot Updater 1.3.0: upgrade hot-updater and the @hot-updater packages to 1.3.0 or later.',
      { output: process.stderr },
    );
    expect(exitWhenFlushed).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("rethrows any other error unchanged", () => {
    const failure = new Error("connect ECONNREFUSED");

    expect(() => endAtSchemaFence(failure)).toThrow(failure);
    expect(p.log.error).not.toHaveBeenCalled();
    expect(exitWhenFlushed).not.toHaveBeenCalled();
  });
});
