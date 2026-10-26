import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => new Set<string>());

vi.mock("google-auth-library", async (importOriginal) => {
  loaded.add("google-auth-library");
  return importOriginal();
});
vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  loaded.add("@hot-updater/cli-tools");
  return importOriginal();
});

describe("secretManager loading", () => {
  it("loads google-auth-library and the CLI tools only when it reads", async () => {
    const { secretManager } = await import("./index");
    const secrets = secretManager({ projectId: "demo-project" });

    expect([...loaded]).toEqual([]);

    vi.stubEnv("CLOUDSDK_AUTH_ACCESS_TOKEN", "");
    vi.stubEnv("GOOGLE_OAUTH_ACCESS_TOKEN", "");
    // No credentials file: Application Default Credentials fail fast.
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent/adc.json");
    try {
      await expect(secrets.get(["asc-api-key"], { cwd: "/" })).rejects.toThrow(
        "secretManager found no Google credentials",
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(loaded.has("google-auth-library")).toBe(true);
  });
});
