import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => new Set<string>());

vi.mock("@azure/keyvault-secrets", async (importOriginal) => {
  loaded.add("@azure/keyvault-secrets");
  return importOriginal();
});
vi.mock("@azure/identity", async (importOriginal) => {
  loaded.add("@azure/identity");
  return importOriginal();
});
vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  loaded.add("@hot-updater/cli-tools");
  return importOriginal();
});

describe("keyVault loading", () => {
  it("loads the Key Vault SDK only when it reads, and @azure/identity only without a credential", async () => {
    const { azureBlobStorage, keyVault } = await import("./index");
    azureBlobStorage({
      connectionString: "UseDevelopmentStorage=true",
      containerName: "bundles",
    });
    const secrets = keyVault({
      vaultUrl: "https://127.0.0.1:1",
      credential: {
        getToken: async () => {
          throw new Error("no credentials in this spec");
        },
      },
    });

    expect([...loaded]).toEqual([]);

    await expect(secrets.get(["asc-api-key"], { cwd: "/" })).rejects.toThrow();
    expect(loaded.has("@azure/keyvault-secrets")).toBe(true);
    expect(loaded.has("@azure/identity")).toBe(false);
  });
});
