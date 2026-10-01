import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCwd, loadConfig, readPackageUp } from "@hot-updater/cli-tools";
import { createEngine } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClosingServerState } from "./__fixtures__/closingServer";
import { doctor } from "./doctor";

vi.mock("../packageJson", () => ({ packageJsonData: { version: "1.0.0" } }));

// The server loads through the CLI's real path: loadServer is not mocked.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(),
  loadConfig: vi.fn(),
  readPackageUp: vi.fn(),
}));

const SERVER = path.join(import.meta.dirname, "__fixtures__/closingServer.ts");

const server = (): ClosingServerState =>
  (globalThis as { __closingServer?: ClosingServerState }).__closingServer!;

let app: string;

beforeEach(async () => {
  vi.clearAllMocks();
  app = await mkdtemp(path.join(os.tmpdir(), "hot-updater-doctor-server-"));
  vi.mocked(getCwd).mockReturnValue(app);
  vi.mocked(readPackageUp).mockResolvedValue({
    packageJson: {
      dependencies: {
        "hot-updater": "1.0.0",
        "@hot-updater/react-native": "1.0.0",
      },
    },
    path: path.join(app, "package.json"),
  } as never);
  vi.mocked(loadConfig).mockResolvedValue({
    server: SERVER,
    updateStrategy: "appVersion",
    platform: {
      ios: { infoPlistPaths: [] },
      android: { androidManifestPaths: [] },
    },
    build: async () => ({}),
  } as never);
  const loaded = (globalThis as { __closingServer?: ClosingServerState })
    .__closingServer;
  if (loaded) {
    // The module stays loaded for the process: reopen its database.
    loaded.closed = false;
    loaded.closes = 0;
    loaded.callsAfterClose = 0;
  }
});

afterEach(async () => {
  await rm(app, { recursive: true, force: true });
});

describe("doctor's server", () => {
  it("is loaded once per run, checked for client plugins and catalogs while open, and closed once", async () => {
    const result = await doctor();

    expect(result).toMatchObject({
      success: true,
      details: {
        releaseCatalogs: { scopes: [], issues: [] },
        artifacts: { unreferenced: [], issues: [] },
      },
    });
    expect(server().callsAfterClose).toBe(0);
    expect(server().closes).toBe(1);
  });

  it("stays open through --fix and the checks after it", async () => {
    // Seed a stale catalog in the module's own database.
    await doctor();
    server().closed = false;
    const [deployed] = await server().hotUpdater.core.deploy([
      {
        bundle: {
          assetBaseStorageUri: "storage://assets",
          gitCommitHash: null,
          id: "01900000-0000-7000-8000-000000000001",
          manifestFileHash: "manifest-hash",
          manifestStorageUri: "storage://artifacts/1/manifest.json",
          metadata: {},
          platform: "ios",
        },
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.x",
        },
      },
    ]);
    const scopeKey = deployed!.release!.scope_key;
    const engine = createEngine(server().database);
    await engine.core.transaction(async (tx) => {
      const row = await tx.findOne("release_catalogs", {
        scope_key: scopeKey,
      });
      tx.update("release_catalogs", row!, {
        catalog_hash: `sha256:${"0".repeat(64)}`,
      });
    });
    await engine.dispose();
    server().closes = 0;

    const result = await doctor({ fix: true });

    expect(result).toMatchObject({
      success: true,
      details: {
        fixes: [{ repair: "release-catalogs", status: "applied" }],
        releaseCatalogs: { scopes: [{ scopeKey, state: "verified" }] },
      },
    });
    expect(server().callsAfterClose).toBe(0);
    expect(server().closes).toBe(1);
  });
});
