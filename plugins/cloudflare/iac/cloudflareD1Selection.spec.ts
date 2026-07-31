import { describe, expect, it } from "vitest";

import { resolveCloudflareReplayD1Database } from "./cloudflareD1Selection";

describe("resolveCloudflareReplayD1Database", () => {
  it("reuses a database when its ID and name both match", () => {
    // Given
    const availableDatabases = [{ name: "hot-updater", uuid: "database-id" }];

    // When
    const resolution = resolveCloudflareReplayD1Database({
      availableDatabases,
      databaseId: "database-id",
      databaseName: "hot-updater",
    });

    // Then
    expect(resolution).toEqual({
      database: availableDatabases[0],
      kind: "existing",
    });
  });

  it("creates a database when neither identifier exists", () => {
    // Given
    const availableDatabases = [{ name: "other", uuid: "other-database-id" }];

    // When
    const resolution = resolveCloudflareReplayD1Database({
      availableDatabases,
      databaseId: "new-database-id",
      databaseName: "new-database",
    });

    // Then
    expect(resolution).toEqual({ kind: "create", name: "new-database" });
  });
});
