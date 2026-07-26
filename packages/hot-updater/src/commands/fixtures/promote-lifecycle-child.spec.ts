import fsPromises from "node:fs/promises";

import type { Bundle } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockPromoteBundle } = vi.hoisted(() => ({
  mockCli: {
    loadConfig: vi.fn(),
    p: {
      confirm: vi.fn(),
      isCancel: vi.fn(() => false),
      log: {
        error: vi.fn(),
        info: vi.fn(),
        message: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
      },
    },
  },
  mockPromoteBundle: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    loadConfig: mockCli.loadConfig,
    p: mockCli.p,
    promoteBundle: mockPromoteBundle,
  };
});

vi.mock("@/utils/printBanner", () => ({
  printBanner: vi.fn(),
}));

import { createDatabasePluginHarness } from "../databasePlugin.testFixtures";

const markerPath = process.env["HOT_UPDATER_PROMOTE_LIFECYCLE_MARKER"];
const mode = process.env["HOT_UPDATER_PROMOTE_LIFECYCLE_MODE"];
const databaseHarness = createDatabasePluginHarness();
const bundle: Bundle = {
  id: "promote-lifecycle-source",
  channel: "internal",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "source-hash",
  storageUri: "s3://bucket/source.zip",
  gitCommitHash: "source-commit",
  message: null,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
};

describe.skipIf(markerPath === undefined || mode === undefined)(
  "promote lifecycle child marker",
  () => {
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );

    beforeEach(() => {
      process.exitCode = undefined;
      databaseHarness.reset();
      databaseHarness.setBundles([bundle]);
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: true,
      });
    });

    afterEach(() => {
      if (isTtyDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
      }
      vi.restoreAllMocks();
    });

    it("writes both owner cleanup markers before the child exits", async () => {
      if (markerPath === undefined || mode === undefined) {
        throw new Error("Lifecycle marker fixture requires its environment.");
      }

      databaseHarness.onUnmount.mockImplementationOnce(async () => {
        await fsPromises.appendFile(markerPath, "database\n");
      });
      mockCli.loadConfig.mockResolvedValue({
        database: databaseHarness.plugin,
        disposeStorage: async () => {
          await fsPromises.appendFile(markerPath, "storage\n");
        },
        storage: async () => ({
          name: "marker-storage",
          supportedProtocol: "s3",
          profiles: {
            node: {
              delete: vi.fn(),
              downloadFile: vi.fn(),
              exists: vi.fn(async () => false),
              upload: vi.fn(),
            },
          },
        }),
      });

      const { handlePromote } = await import("../promote");
      switch (mode) {
        case "cancel":
          mockCli.p.confirm.mockResolvedValueOnce(false);
          await handlePromote(bundle.id, { target: "beta" });
          expect(process.exitCode).toBe(2);
          break;
        case "failure": {
          const operationError = new Error("marker promotion failed");
          mockPromoteBundle.mockRejectedValueOnce(operationError);
          await expect(
            handlePromote(bundle.id, { target: "beta", yes: true }),
          ).rejects.toBe(operationError);
          process.exitCode = 1;
          break;
        }
        default:
          throw new Error(`Unsupported lifecycle marker mode: ${mode}`);
      }

      await fsPromises.appendFile(markerPath, `handled:${process.exitCode}\n`);
      await fsPromises.appendFile(markerPath, `exit:${process.exitCode}\n`);
      process.exit(process.exitCode);
    });
  },
);
