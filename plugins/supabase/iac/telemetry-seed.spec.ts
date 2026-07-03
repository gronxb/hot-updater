import { describe, expect, it, vi } from "vitest";

const upsertTelemetryKeyCredential = vi.fn(async () => {});

vi.mock("../src/supabaseTelemetry", () => ({
  createSupabaseTelemetryOperations: vi.fn(() => ({
    upsertTelemetryKeyCredential,
  })),
}));

import { seedSupabaseTelemetryKey, SOURCE_TEMPLATE } from "./index";

describe("Supabase telemetry init seed", () => {
  it("generates a hutk key through Supabase operations", async () => {
    // Given / When
    const issued = await seedSupabaseTelemetryKey({
      serviceRoleKey: "service-role-key",
      supabaseUrl: "https://project.supabase.co",
    });

    // Then
    expect(issued.telemetryKey).toMatch(/^hutk_.+/);
    expect(issued.telemetryKey.endsWith(issued.telemetryKeySuffix)).toBe(true);
    expect(upsertTelemetryKeyCredential).toHaveBeenCalledWith(
      {
        active: true,
        keyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        telemetryKeySuffix: issued.telemetryKeySuffix,
      },
      undefined,
    );
  });

  it("prints the plaintext key only in the SDK setup snippet", () => {
    // Given
    const telemetryKey = "hutk_supabase_seed";

    // When
    const snippet = SOURCE_TEMPLATE.replace(
      "%%source%%",
      "https://example.com",
    ).replace("%%telemetryKey%%", telemetryKey);

    // Then
    expect(snippet).toContain("analytics");
    expect(snippet).toContain(`telemetryKey: "${telemetryKey}"`);
  });
});
