import { p } from "@hot-updater/cli-tools";
import {
  createStorageAdapter,
  type NativeBuildRegistration,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";

const { confirm, loadConfig, loadServer, log } = vi.hoisted(() => ({
  confirm: vi.fn(),
  loadConfig: vi.fn(),
  loadServer: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig,
  p: { confirm, isCancel: () => false, log },
}));
vi.mock("../utils/loadServer", () => ({ loadServer }));
vi.mock("@/utils/loadServer", () => ({ loadServer }));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabaseHarness();

const BUILD_ID = "01900000-0000-7000-8000-00000000b001";
const MIN_BUNDLE_ID = "01900000-0000-7000-8000-00000000a001";
const ARTIFACT_URI = `storage://native-builds/ios/${BUILD_ID}/App.ipa`;

const register = () =>
  databaseHarness.core.registerNativeBuild({
    id: BUILD_ID,
    minBundleId: MIN_BUNDLE_ID,
    platform: "ios",
    channel: "qa-preview",
    fingerprintHash: null,
    appVersion: "1.2.0",
    gitCommitHash: null,
    buildKey: null,
    artifact: { kind: "ipa", storageUri: ARTIFACT_URI, byteSize: 49_000_000 },
    embeddedBundle: {
      manifestStorageUri: `storage://bundles/${MIN_BUNDLE_ID}/manifest.json`,
      manifestFileHash: "manifest-hash",
      assetBaseStorageUri: "storage://assets",
    },
  } as NativeBuildRegistration);

const events: string[] = [];
const deleteObject = vi.fn(async ({ storageUri }: { storageUri: string }) => {
  events.push(`storage ${storageUri}`);
  return { deleted: true as const };
});

const useStorage = (storage: StorageAdapter) =>
  loadServer.mockResolvedValue(
    testServer({ database: databaseHarness.database, storage }),
  );

const stdinIsTTY = process.stdin.isTTY;
const setStdinTTY = (isTTY: boolean | undefined) =>
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: isTTY,
  });

const output = () =>
  JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));

describe("handleNativeBuildDelete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    events.length = 0;
    setStdinTTY(true);
    loadConfig.mockResolvedValue({});
    useStorage(
      createStorageAdapter({
        name: "test",
        protocol: "storage",
        delete: deleteObject,
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setStdinTTY(stdinIsTTY);
    process.exitCode = undefined;
  });

  it("deletes the build's rows, then its artifact, after asking", async () => {
    const build = await register();
    const deleteNativeBuild = databaseHarness.core.deleteNativeBuild;
    vi.spyOn(databaseHarness.core, "deleteNativeBuild").mockImplementation(
      async (id) => {
        events.push(`database ${id}`);
        return deleteNativeBuild(id);
      },
    );
    confirm.mockResolvedValue(true);
    const { handleNativeBuildDelete } = await import("./nativeBuild");

    await handleNativeBuildDelete(BUILD_ID, { json: true });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(events).toEqual([`database ${BUILD_ID}`, `storage ${ARTIFACT_URI}`]);
    expect(output()).toEqual({
      id: BUILD_ID,
      deleted: true,
      nativeBuild: build,
      artifactDeleted: true,
    });
    await expect(
      databaseHarness.core.getNativeBuild(BUILD_ID),
    ).resolves.toBeNull();
    await expect(
      databaseHarness.core.getBundle(MIN_BUNDLE_ID),
    ).resolves.toBeNull();
    // The channel it kept can go now.
    const channel = await databaseHarness.core.findChannelByName("qa-preview");
    await expect(
      databaseHarness.core.deleteChannel(channel!.id),
    ).resolves.toEqual({ deleted: true });
    expect(process.exitCode).toBeUndefined();
  });

  it("deletes nothing and succeeds for a build that is not registered, so it can run again", async () => {
    await register();
    const { handleNativeBuildDelete } = await import("./nativeBuild");

    await handleNativeBuildDelete(BUILD_ID, { json: true, yes: true });
    await handleNativeBuildDelete(BUILD_ID, { json: true, yes: true });

    expect(output()).toEqual({
      id: BUILD_ID,
      deleted: false,
      reason: "not_found",
    });
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps everything when the confirmation is declined", async () => {
    await register();
    confirm.mockResolvedValue(false);
    const { handleNativeBuildDelete } = await import("./nativeBuild");

    await expect(handleNativeBuildDelete(BUILD_ID, {})).rejects.toThrow(
      "process.exit",
    );

    expect(process.exit).toHaveBeenCalledWith(2);
    expect(deleteObject).not.toHaveBeenCalled();
    await expect(
      databaseHarness.core.getNativeBuild(BUILD_ID),
    ).resolves.not.toBeNull();
  });

  it("refuses to ask without a terminal, naming -y", async () => {
    await register();
    setStdinTTY(undefined);
    const { handleNativeBuildDelete } = await import("./nativeBuild");

    await expect(handleNativeBuildDelete(BUILD_ID, {})).rejects.toThrow(
      "process.exit",
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Re-run with -y in a non-interactive shell."),
    );
    expect(deleteObject).not.toHaveBeenCalled();
    await expect(
      databaseHarness.core.getNativeBuild(BUILD_ID),
    ).resolves.not.toBeNull();
  });

  it("says where the artifact stays when its deletion fails, and exits 1", async () => {
    await register();
    useStorage(
      createStorageAdapter({
        name: "test",
        protocol: "storage",
        delete: async () => {
          throw new Error("access denied");
        },
      }),
    );
    const { handleNativeBuildDelete } = await import("./nativeBuild");

    await handleNativeBuildDelete(BUILD_ID, { json: true, yes: true });

    expect(output()).toMatchObject({ deleted: true, artifactDeleted: false });
    expect(console.error).toHaveBeenCalledWith(
      [
        "The native build is deleted, but its artifact is not.",
        "access denied",
        `Delete ${ARTIFACT_URI} from storage.`,
      ].join("\n"),
    );
    expect(process.exitCode).toBe(1);
    await expect(
      databaseHarness.core.getNativeBuild(BUILD_ID),
    ).resolves.toBeNull();
  });

  it("deletes nothing with a storage adapter that can't delete", async () => {
    await register();
    useStorage(createStorageAdapter({ name: "readonly", protocol: "storage" }));
    const { handleNativeBuildDelete } = await import("./nativeBuild");

    await expect(
      handleNativeBuildDelete(BUILD_ID, { yes: true }),
    ).rejects.toThrow("process.exit");

    expect(log.error).toHaveBeenCalledWith(
      'Storage adapter "readonly" does not implement delete.',
    );
    await expect(
      databaseHarness.core.getNativeBuild(BUILD_ID),
    ).resolves.not.toBeNull();
  });
});

// The terminal these specs simulate takes prompts only outside CI, and CI
// runners set CI.
beforeEach(() => {
  vi.stubEnv("CI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
