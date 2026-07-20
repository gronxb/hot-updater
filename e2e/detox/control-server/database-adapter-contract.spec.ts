import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const controllerPath = path.join(import.meta.dirname, "controller.ts");

describe("Detox control-server database v2 consumer", () => {
  it("uses the direct adapter through the aggregate database client", async () => {
    // Given
    const controllerSource = await fs.readFile(controllerPath, "utf8");

    // When
    const databaseHelperSource = controllerSource.slice(
      controllerSource.indexOf("async function withDatabaseClient"),
      controllerSource.indexOf("async function fetchProviderBundlesPage"),
    );

    // Then
    expect(databaseHelperSource).toContain(
      "createDatabaseClient(config.database)",
    );
    expect(databaseHelperSource).not.toContain("config.database()");
  });

  it("batches remote reset updates through mutate", async () => {
    // Given
    const controllerSource = await fs.readFile(controllerPath, "utf8");

    // When
    const clearProviderBundleRecordsSource = controllerSource.slice(
      controllerSource.indexOf("async function clearProviderBundleRecords"),
      controllerSource.indexOf("async function clearProviderBundles"),
    );
    const clearProviderBundlesSource = controllerSource.slice(
      controllerSource.indexOf("async function clearProviderBundles"),
      controllerSource.indexOf("function updateTrackedBundleRecord"),
    );

    // Then
    expect(clearProviderBundleRecordsSource).toContain(
      "databaseClient.mutate(async (transaction) =>",
    );
    expect(clearProviderBundleRecordsSource).not.toContain("commitBundle");
    expect(clearProviderBundlesSource).toContain(
      "return withDatabaseMutationLock(",
    );
  });
});
