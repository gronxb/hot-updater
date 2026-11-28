import { stripVTControlCharacters } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockServer, mockStorageAdapter } = vi.hoisted(() => {
  const mockStorageAdapter = {
    delete: vi.fn(),
    get: vi.fn(),
    name: "mock-storage",
    protocol: "s3",
    put: vi.fn(),
  };
  const mockServer = {
    createBundleDiff: vi.fn(),
  };
  const mockCli = {
    loadConfig: vi.fn(),
    p: {
      isCancel: vi.fn(),
      log: {
        error: vi.fn(),
      },
      note: vi.fn(),
      outro: vi.fn(),
    },
  };

  return {
    mockCli,
    mockServer,
    mockStorageAdapter,
  };
});
const { mockLoadServer } = vi.hoisted(() => ({ mockLoadServer: vi.fn() }));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: mockCli.loadConfig,
  p: mockCli.p,
}));

vi.mock("@/utils/createBundleDiff", () => ({
  createBundleDiff: mockServer.createBundleDiff,
}));

vi.mock("@/prompts/getPlatform", () => ({
  getPlatform: vi.fn(),
}));

vi.mock("@/utils/loadServer", async () => ({
  ...(await vi.importActual<typeof import("../utils/loadServer")>(
    "../utils/loadServer",
  )),
  loadServer: mockLoadServer,
}));

vi.mock("@/utils/printBanner", () => ({
  printBanner: vi.fn(),
}));

import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";
import { createPatch } from "./patch";

const databaseHarness = createDatabaseHarness();

describe("createPatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();

    mockCli.p.isCancel.mockReturnValue(false);
    mockServer.createBundleDiff.mockResolvedValue({
      id: "target-bundle",
    });
    mockCli.loadConfig.mockResolvedValue({});
    mockLoadServer.mockResolvedValue(
      testServer({
        database: databaseHarness.database,
        storage: mockStorageAdapter,
      }),
    );
  });

  it("creates a manual patch artifact and prints a summary", async () => {
    await createPatch({
      baseBundleId: "base-bundle",
      bundleId: "target-bundle",
      channel: "production",
      interactive: false,
      platform: "ios",
    });

    expect(mockCli.loadConfig).toHaveBeenCalledWith({
      channel: "production",
      platform: "ios",
    });
    const [rendered, title] = mockCli.p.note.mock.calls[0]!;
    const summary = stripVTControlCharacters(String(rendered));
    expect(title).toBe("Patch");
    expect(summary).toMatch(/^Channel {2,}production/m);
    expect(summary).toMatch(/^Platform {2,}ios/m);
    expect(summary).toMatch(/^Base artifact ID {2,}base-bundle/m);
    expect(summary).toMatch(/^Target artifact ID {2,}target-bundle/m);
    expect(mockServer.createBundleDiff).toHaveBeenCalledWith(
      {
        baseBundleId: "base-bundle",
        bundleId: "target-bundle",
      },
      {
        core: databaseHarness.database.core,
        signingPublicKey: null,
        storageAdapter: mockStorageAdapter,
      },
      {
        makePrimary: true,
      },
    );
    expect(mockCli.p.outro).toHaveBeenCalledWith("Patch ready.");
    expect(databaseHarness.dispose).toHaveBeenCalledOnce();
  });

  describe("from a native build's built-in bundle", () => {
    const register = (n: number, channel: string, isSandbox?: true) =>
      databaseHarness.database.core.registerNativeBuild({
        id: `01900000-0000-7000-8000-00000000b00${n}`,
        platform: "ios",
        channel,
        fingerprintHash: "fingerprint-hash",
        appVersion: null,
        minBundleId: `018f0000-0000-7000-8000-00000000000${n}`,
        gitCommitHash: null,
        buildKey: null,
        ...(isSandbox === undefined
          ? {}
          : {
              isSandbox,
              sandboxUrlScheme: "acme-preview",
              sandboxAppId: "com.example.app",
              exportMethod: "ad-hoc" as const,
            }),
        artifact: {
          kind: "ipa",
          storageUri: `storage://native-builds/ios/b00${n}/App.ipa`,
          byteSize: 1_024,
        },
        embeddedBundle: {
          manifestStorageUri: `storage://artifacts/b00${n}/manifest.json`,
          manifestFileHash: `built-in-manifest-${n}`,
          assetBaseStorageUri: "storage://assets",
        },
      });
    const patchFrom = (baseBundleId: string) =>
      createPatch({
        baseBundleId,
        bundleId: "target-bundle",
        channel: "production",
        interactive: false,
        platform: "ios",
      });

    it("reports the server's refusal of a sandbox build's, which createBundleDiff cleans up after", async () => {
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      try {
        const sandbox = await register(1, "pr-134", true);
        mockServer.createBundleDiff.mockRejectedValueOnce(
          new Error("A sandbox build's built-in bundle is no patch base."),
        );

        await patchFrom(sandbox.min_bundle_id);

        expect(mockServer.createBundleDiff).toHaveBeenCalledOnce();
        expect(mockCli.p.log.error).toHaveBeenCalledWith(
          "A sandbox build's built-in bundle is no patch base.",
        );
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        exit.mockRestore();
      }
    });

    it("patches from another build's", async () => {
      await register(1, "pr-134", true);
      const store = await register(2, "production");

      await patchFrom(store.min_bundle_id);

      expect(mockServer.createBundleDiff).toHaveBeenCalledOnce();
      expect(mockCli.p.outro).toHaveBeenCalledWith("Patch ready.");
    });
  });
});
