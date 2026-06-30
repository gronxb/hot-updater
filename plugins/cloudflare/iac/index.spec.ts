import { describe, expect, it, vi } from "vitest";

import {
  createCloudflareTelemetrySeed,
  getCloudflareRuntimeBaseURL,
  seedCloudflareTelemetryKey,
  SOURCE_TEMPLATE,
} from "./index";

describe("Cloudflare telemetry init seed", () => {
  it("generates a hutk key and stores only hash plus suffix", async () => {
    // Given
    const query = vi.fn(async () => ({}));
    const cf = { d1: { database: { query } } };

    // When
    const issued = await seedCloudflareTelemetryKey({
      accountId: "account-id",
      cf,
      databaseId: "database-id",
    });

    // Then
    expect(issued.telemetryKey).toMatch(/^hutk_.+/);
    expect(issued.telemetryKey.endsWith(issued.telemetryKeySuffix)).toBe(true);
    expect(query).toHaveBeenCalledWith(
      "database-id",
      expect.objectContaining({
        account_id: "account-id",
        params: expect.arrayContaining(["default", issued.telemetryKeySuffix]),
      }),
    );
    expect(JSON.stringify(query.mock.calls)).not.toContain(issued.telemetryKey);
  });

  it("creates a hash that does not contain plaintext", () => {
    // Given / When
    const seed = createCloudflareTelemetrySeed();

    // Then
    expect(seed.telemetryKey).toMatch(/^hutk_.+/);
    expect(seed.telemetryKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(seed.telemetryKeyHash).not.toContain(seed.telemetryKey);
  });

  it("prints the plaintext key only in the SDK setup snippet", () => {
    // Given
    const telemetryKey = "hutk_cloudflare_seed";

    // When
    const runtimeBaseURL = getCloudflareRuntimeBaseURL({
      subdomain: "workers.dev",
      workerName: "hot-updater",
    });

    // When
    const snippet = SOURCE_TEMPLATE.replace(
      "%%source%%",
      runtimeBaseURL,
    ).replace("%%telemetryKey%%", telemetryKey);

    // Then
    expect(snippet).toContain(`baseURL: "${runtimeBaseURL}"`);
    expect(snippet).not.toContain(
      `baseURL: "${runtimeBaseURL}/api/check-update"`,
    );
    expect(snippet).toContain("analytics: {");
    expect(snippet).toContain(`telemetryKey: "${telemetryKey}"`);
  });
});
