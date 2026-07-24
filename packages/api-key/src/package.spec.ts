import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("@hot-updater/api-key package", () => {
  it("keeps Node-only provisioning behind its own export", async () => {
    // Given
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports: Record<string, unknown>;
    };
    const rootSources = await Promise.all(
      ["./index.ts", "./base64url.ts"].map((path) =>
        readFile(new URL(path, import.meta.url), "utf8"),
      ),
    );

    // When / Then
    expect(packageJson.exports).toHaveProperty(".");
    expect(packageJson.exports).toHaveProperty("./provisioning");
    expect(rootSources.join("\n")).not.toMatch(
      /(?:from|import)\s*\(?["']node:/u,
    );
    expect(rootSources.join("\n")).not.toContain("./provisioning");
  });
});
