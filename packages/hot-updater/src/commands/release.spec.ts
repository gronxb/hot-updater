import { updateReleasePolicy } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDatabasePluginHarness,
  type DeploymentSeed,
} from "./databasePlugin.testFixtures";
import {
  commitDeployment,
  type DeployReleasePolicy,
} from "./deployTransaction";

const { confirm, loadConfig, log } = vi.hoisted(() => ({
  confirm: vi.fn(),
  loadConfig: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig,
  p: {
    confirm,
    isCancel: vi.fn(() => false),
    log,
  },
}));

vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabasePluginHarness();
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

const deployment = (
  id: string,
  releaseOverrides: Partial<DeployReleasePolicy> = {},
): DeploymentSeed => ({
  bundle: {
    archiveByteSize: 1024,
    fileHash: `hash-${id}`,
    gitCommitHash: null,
    id,
    platform: "ios",
    storageUri: `storage://artifacts/${id}.zip`,
  },
  release: {
    channel: "production",
    enabled: true,
    fingerprintHash: null,
    message: "ready",
    rolloutCohortCount: 500,
    shouldForceUpdate: true,
    targetAppVersion: "1.0.x",
    targetCohorts: ["staff"],
    ...releaseOverrides,
  },
});

describe("Release commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({ database: databaseHarness.plugin });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
  });

  it("filters Releases by Bundle and includes creation time in the table", async () => {
    const first = deployment("01900000-0000-7000-8000-000000000001");
    const second = deployment("01900000-0000-7000-8000-000000000002");
    await databaseHarness.seedDeployments([first, second]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleReleaseList } = await import("./release");

    await handleReleaseList({ bundleId: first.bundle.id });

    const rendered = String(output.mock.calls[0]?.[0]);
    expect(rendered).toContain("Created");
    expect(rendered).toContain(first.bundle.id);
    expect(rendered).not.toContain(second.bundle.id);
  });

  it("shows console ID and policy without file or catalog internals", async () => {
    const seeded = deployment("01900000-0000-7000-8000-000000000001");
    const { release } = await commitDeployment({
      database: databaseHarness.plugin,
      ...seeded,
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleReleaseShow } = await import("./release");

    await handleReleaseShow(release!.id);

    const rendered = String(output.mock.calls[0]?.[0]);
    for (const field of [
      "Strategy",
      "Target cohorts",
      "Source ID",
      "Created",
      "Updated",
    ]) {
      expect(rendered).toContain(field);
    }
    expect(rendered).toContain("staff");
    expect(rendered).toContain("APP_VERSION");
    expect(rendered).toMatch(/\bID:\s+/);
    expect(rendered).toContain(release!.id);
    expect(rendered).not.toContain(seeded.bundle.id);
    expect(rendered).not.toContain(release!.scope_key);
    expect(rendered).toMatch(/Revision:\s+1/);
    expect(rendered).not.toMatch(/Release ID|Scope|Generation/);
  });

  it("keeps the same console ID through policy edits, rollback, and deletion", async () => {
    const seeded = deployment("01900000-0000-7000-8000-000000000001");
    const { release } = await commitDeployment({
      database: databaseHarness.plugin,
      ...seeded,
    });
    const id = release!.id;
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const {
      handleReleaseDelete,
      handleReleaseEnablement,
      handleReleaseUpdate,
    } = await import("./release");

    await handleReleaseUpdate(id, { message: "verified update", yes: true });
    await expect(
      databaseHarness.plugin.models.releases.findById(id),
    ).resolves.toMatchObject({ message: "verified update", revision: 2 });
    await handleReleaseEnablement(id, false, { yes: true });
    await handleReleaseEnablement(id, true, { yes: true });
    await handleReleaseEnablement(id, false, { yes: true });
    await handleReleaseDelete(id, { yes: true });

    expect(
      output.mock.calls.map(([rendered]) => String(rendered).split("\n")[0]),
    ).toEqual([
      "Release updated",
      "Release disabled",
      "Release enabled",
      "Release disabled",
      "Release deleted",
    ]);
    for (const [rendered] of [
      ...output.mock.calls,
      ...log.message.mock.calls,
    ]) {
      expect(rendered).toMatch(/\bID:\s+/);
      expect(rendered).toContain(id);
      expect(rendered).not.toContain(seeded.bundle.id);
      expect(rendered).not.toContain(release!.scope_key);
      expect(rendered).not.toMatch(/Release ID|Scope|Generation/);
    }
    await expect(
      databaseHarness.plugin.models.releases.findById(id),
    ).resolves.toBeNull();
    await expect(
      databaseHarness.plugin.models.bundles.findById(seeded.bundle.id),
    ).resolves.not.toBeNull();
  });

  it("previews device-dependent fallback and warns for the sole enabled Release", async () => {
    const seeded = deployment("01900000-0000-7000-8000-000000000001");
    await databaseHarness.seedDeployments([seeded]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleReleaseEnablement } = await import("./release");

    await handleReleaseEnablement(seeded.bundle.id, false, { yes: true });

    expect(log.message).toHaveBeenCalledWith(
      expect.stringContaining("previous compatible enabled Release or BUILTIN"),
    );
    expect(log.message).toHaveBeenCalledWith(
      expect.stringContaining("device-dependent"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("only enabled Release"),
    );
    await expect(
      databaseHarness.plugin.models.releases.findById(seeded.bundle.id),
    ).resolves.toMatchObject({ enabled: false, revision: 2 });
  });

  it("uses the previewed revision as the disable CAS boundary", async () => {
    const seeded = deployment("01900000-0000-7000-8000-000000000001");
    await databaseHarness.seedDeployments([seeded]);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    confirm.mockImplementationOnce(async () => {
      await updateReleasePolicy({
        database: databaseHarness.plugin,
        patch: { message: "changed concurrently" },
        releaseId: seeded.bundle.id,
      });
      return true;
    });
    const { handleReleaseEnablement } = await import("./release");

    await expect(
      handleReleaseEnablement(seeded.bundle.id, false, {}),
    ).rejects.toThrow(/revision/i);

    await expect(
      databaseHarness.plugin.models.releases.findById(seeded.bundle.id),
    ).resolves.toMatchObject({
      enabled: true,
      message: "changed concurrently",
      revision: 2,
    });
  });

  it("keeps JSON disable output machine-readable without a human preview", async () => {
    const seeded = deployment("01900000-0000-7000-8000-000000000001");
    const { release } = await commitDeployment({
      database: databaseHarness.plugin,
      ...seeded,
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleReleaseEnablement } = await import("./release");

    await handleReleaseEnablement(release!.id, false, {
      json: true,
      yes: true,
    });

    const payload = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(payload.release).toMatchObject({
      enabled: false,
      bundle_id: seeded.bundle.id,
      id: release!.id,
      revision: 2,
    });
    expect(payload.catalog).toEqual(
      expect.objectContaining({
        generation: 2,
        scope_key: release!.scope_key,
      }),
    );
    expect(log.message).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
