import { stripVTControlCharacters } from "node:util";

import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";

const { loadConfig, log } = vi.hoisted(() => ({
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
    confirm: vi.fn(),
    isCancel: vi.fn(() => false),
    log,
  },
}));

vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabasePluginHarness();

const artifact = (
  id: string,
  platform: Bundle["platform"] = "ios",
): Bundle => ({
  archiveByteSize: 1024,
  id,
  platform,
  fileHash: `hash-${id}`,
  storageUri: `storage://artifacts/${id}.zip`,
  gitCommitHash: "1234567890abcdef",
});

const releaseReference = (id: string, bundleId: string): ReleaseRow => ({
  bundle_id: bundleId,
  channel_id: "channel-production",
  created_at_ms: 1,
  enabled: true,
  fingerprint_hash: null,
  id,
  kind: "BUNDLE",
  message: null,
  operation: "DEPLOY",
  platform: "ios",
  revision: 1,
  rollout_cohort_count: 1_000,
  scope_key: "scope-production-ios",
  should_force_update: false,
  source_release_id: null,
  strategy: "APP_VERSION",
  target_app_version: "1.0.x",
  target_cohorts: [],
  updated_at_ms: 1,
});

describe("Bundle commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({ database: databaseHarness.plugin });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists separate console IDs for promotions sharing a file", async () => {
    const bundle = artifact("00000000-0000-7000-8000-000000000001");
    const androidBundle = artifact("android-file", "android");
    databaseHarness.setBundles([bundle, androidBundle]);
    for (const name of ["production", "staging"]) {
      await databaseHarness.plugin.models.channels.insert({
        row: { id: `channel-${name}`, name },
        onConflict: "returnExisting",
      });
    }
    const source = releaseReference(
      "00000000-0000-7000-8000-000000000002",
      bundle.id,
    );
    const promoted = {
      ...source,
      id: "00000000-0000-7000-8000-000000000003",
      channel_id: "channel-staging",
      operation: "PROMOTE" as const,
      source_release_id: source.id,
    };
    const android = {
      ...source,
      id: "00000000-0000-7000-8000-000000000004",
      bundle_id: androidBundle.id,
      platform: "android" as const,
    };
    await databaseHarness.plugin.commit({
      changes: [source, promoted, android].map((row) => ({
        model: "releases",
        operation: "insert",
        row,
      })),
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleBundleList, handleBundleShow } = await import("./bundle");

    await handleBundleList({ platform: "ios", limit: 5 });

    const table = stripVTControlCharacters(
      String(output.mock.calls.at(-1)?.[0]),
    );
    expect(table).toContain(source.id);
    expect(table).toContain(promoted.id);
    expect(table).not.toContain(bundle.id);
    expect(table).not.toContain(android.id);
    expect(table).not.toContain("Release ID");
    expect(table).not.toContain("Bundle / Embedded");

    await handleBundleList({ json: true, platform: "ios", limit: 5 });
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual([
      expect.objectContaining({ id: promoted.id, bundle_id: bundle.id }),
      expect.objectContaining({ id: source.id, bundle_id: bundle.id }),
    ]);

    await handleBundleShow(promoted.id);
    const summary = stripVTControlCharacters(
      String(output.mock.calls.at(-1)?.[0]),
    );
    expect(summary).toContain(`ID:`);
    expect(summary).toContain(promoted.id);
    expect(summary).toContain("staging");
    expect(summary).not.toContain(bundle.id);

    await handleBundleShow(promoted.id, { json: true });
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      id: promoted.id,
      bundle_id: bundle.id,
      source_release_id: source.id,
    });
  });

  it("combines the v0 channel and target app version filters", async () => {
    const bundle = artifact("00000000-0000-7000-8000-000000000011");
    databaseHarness.setBundles([bundle]);
    for (const name of ["production", "staging"]) {
      await databaseHarness.plugin.models.channels.insert({
        row: { id: `channel-${name}`, name },
        onConflict: "returnExisting",
      });
    }
    const matching = releaseReference(
      "00000000-0000-7000-8000-000000000012",
      bundle.id,
    );
    const otherVersion = {
      ...matching,
      id: "00000000-0000-7000-8000-000000000013",
      target_app_version: "2.0.x",
    };
    const otherChannel = {
      ...matching,
      id: "00000000-0000-7000-8000-000000000014",
      channel_id: "channel-staging",
    };
    await databaseHarness.plugin.commit({
      changes: [matching, otherVersion, otherChannel].map((row) => ({
        model: "releases" as const,
        operation: "insert" as const,
        row,
      })),
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { handleBundleList } = await import("./bundle");

    await handleBundleList({
      channel: "production",
      targetAppVersion: "1.0.x",
      limit: 5,
    });

    const table = stripVTControlCharacters(
      String(output.mock.calls.at(-1)?.[0]),
    );
    expect(table).toContain(matching.id);
    expect(table).not.toContain(otherVersion.id);
    expect(table).not.toContain(otherChannel.id);
  });

  it("translates internal release mutation errors at the public boundary", async () => {
    const { handleBundleUpdate } = await import("./bundle");

    await expect(
      handleBundleUpdate("00000000-0000-7000-8000-000000000099", {
        message: "updated",
        yes: true,
      }),
    ).rejects.toMatchObject({
      message: 'Bundle "00000000-0000-7000-8000-000000000099" was not found.',
      cause: expect.objectContaining({
        message:
          'Release "00000000-0000-7000-8000-000000000099" was not found.',
      }),
    });
  });
});
