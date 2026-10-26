import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => new Set<string>());

vi.mock("@aws-sdk/client-secrets-manager", async (importOriginal) => {
  loaded.add("@aws-sdk/client-secrets-manager");
  return importOriginal();
});
vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  loaded.add("@hot-updater/cli-tools");
  return importOriginal();
});

describe("secretsManager loading", () => {
  it("loads the Secrets Manager SDK and the CLI tools only when it reads", async () => {
    const { s3Storage, secretsManager } = await import("./index");
    s3Storage({ bucketName: "bundles", region: "us-east-1" });
    const secrets = secretsManager({
      region: "us-east-1",
      credentials: async () => {
        throw new Error("no credentials in this spec");
      },
    });

    expect([...loaded]).toEqual([]);

    await expect(secrets.get(["asc-api-key"], { cwd: "/" })).rejects.toThrow(
      "no credentials in this spec",
    );
    expect(loaded.has("@aws-sdk/client-secrets-manager")).toBe(true);
  });
});
