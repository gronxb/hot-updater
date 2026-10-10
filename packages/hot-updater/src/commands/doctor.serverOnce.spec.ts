import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assembleServer,
  getCwd,
  loadConfig,
  readPackageUp,
} from "@hot-updater/cli-tools";
import { createEngine } from "@hot-updater/plugin-core";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ClosingDatabaseState,
  createClosingDatabase,
} from "./__fixtures__/closingDatabase";
import { doctor } from "./doctor";

vi.mock("../packageJson", () => ({ packageJsonData: { version: "1.0.0" } }));

// The server loads through the CLI's real path: loadServer is not mocked.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(),
  loadConfig: vi.fn(),
  readPackageUp: vi.fn(),
}));

let app: string;
let closing: ReturnType<typeof createClosingDatabase>;
let state: ClosingDatabaseState;

beforeEach(async () => {
  vi.clearAllMocks();
  app = await mkdtemp(path.join(os.tmpdir(), "hot-updater-doctor-server-"));
  closing = createClosingDatabase();
  state = closing.state;
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
    database: closing.database,
    storage: createReleaseCatalogTestStorage(),
    plugins: [],
    updateStrategy: "appVersion",
    platform: {
      ios: { infoPlistPaths: [] },
      android: { androidManifestPaths: [] },
    },
    build: async () => ({}),
  } as never);
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
    expect(state.callsAfterClose).toBe(0);
    expect(state.closes).toBe(1);
  });

  it("stays open through --fix and the checks after it", async () => {
    // Seed a stale catalog in the configured database.
    const [deployed] = await assembleServer({
      database: closing.database,
    }).core.deploy([
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
    const engine = createEngine(closing.database);
    await engine.core.transaction(async (tx) => {
      const row = await tx.findOne("release_catalogs", {
        scope_key: scopeKey,
      });
      tx.update("release_catalogs", row!, {
        catalog_hash: `sha256:${"0".repeat(64)}`,
      });
    });
    await engine.dispose();

    const result = await doctor({ fix: true });

    expect(result).toMatchObject({
      success: true,
      details: {
        fixes: [{ repair: "release-catalogs", status: "applied" }],
        releaseCatalogs: { scopes: [{ scopeKey, state: "verified" }] },
      },
    });
    expect(state.callsAfterClose).toBe(0);
    expect(state.closes).toBe(1);
  });
});
