import { describe, expect, expectTypeOf, it } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import * as legacyServer from "./index";
import {
  createLegacyHotUpdater,
  type LegacyCreateHotUpdaterOptions,
} from "./index";

describe("legacy server bridge", () => {
  it("exports only the legacy constructor at runtime", () => {
    expect(Object.keys(legacyServer)).toEqual(["createLegacyHotUpdater"]);
  });

  it("keeps Analytics absent when the legacy route flag is disabled", async () => {
    // Given
    const runtime = createLegacyHotUpdater({
      basePath: "/hot-updater",
      database: createInMemoryDatabasePlugin(),
      routes: {
        analytics: false,
        bundles: false,
        updateCheck: false,
      },
    });

    // When
    const response = await runtime.handler(
      new Request("https://example.com/hot-updater/events", {
        method: "POST",
      }),
    );

    // Then
    expect(runtime.features).toEqual({});
    expect(response.status).toBe(404);
  });

  it("keeps legacy bundle routes public without Analytics", async () => {
    // Given
    const runtime = createLegacyHotUpdater({
      basePath: "/hot-updater",
      database: createInMemoryDatabasePlugin(),
      routes: {
        analytics: false,
        bundles: true,
        updateCheck: false,
      },
    });

    // When
    const response = await runtime.handler(
      new Request("https://example.com/hot-updater/api/bundles/channels"),
    );

    // Then
    expect(response.status).toBe(200);
  });

  it("keeps legacy bundle routes public with Analytics", async () => {
    // Given
    const runtime = createLegacyHotUpdater({
      basePath: "/hot-updater",
      database: createInMemoryDatabasePlugin(),
      routes: {
        analytics: true,
        bundles: true,
        updateCheck: false,
      },
    });

    // When
    const response = await runtime.handler(
      new Request("https://example.com/hot-updater/api/bundles/channels"),
    );

    // Then
    expect(response.status).toBe(200);
  });

  it("installs the public Analytics compatibility manifest", async () => {
    // Given
    const runtime = createLegacyHotUpdater({
      basePath: "/hot-updater",
      database: createInMemoryDatabasePlugin(),
      routes: {
        analytics: true,
        bundles: false,
        updateCheck: false,
      },
    });

    // When
    const response = await runtime.handler(
      new Request("https://example.com/hot-updater/api/installations"),
    );

    // Then
    expect(runtime.features.analytics.status).toBe("available");
    if (runtime.features.analytics.status !== "available") {
      throw new Error("Expected available legacy Analytics.");
    }
    if (!("searchInstallations" in runtime)) {
      throw new Error("Expected legacy Analytics aliases.");
    }
    expect(runtime.searchInstallations).toBe(
      runtime.features.analytics.searchInstallations,
    );
    expect(response.status).toBe(200);
  });

  it("keeps the legacy route group exact and excludes eventIngestion", () => {
    type Routes = NonNullable<LegacyCreateHotUpdaterOptions["routes"]>;

    expectTypeOf<keyof Routes>().toEqualTypeOf<
      "analytics" | "bundles" | "updateCheck"
    >();
  });
});
