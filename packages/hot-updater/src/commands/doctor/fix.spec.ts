import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { isExpoCNG } from "../../utils/expoDetection";
import { syncFingerprintFiles } from "../../utils/fingerprint";
import { isProjectFileTracked } from "../../utils/git";
import { writePublicKeyToNativeFiles } from "../keys";
import type { DoctorContext } from "./context";
import { applyDoctorFixes } from "./fix";
import { type DoctorIssueCode, fixesWroteNativeFiles } from "./issues";
import {
  deleteUnreferencedArtifacts,
  rebuildReleaseCatalogs,
} from "./serverData";

vi.mock("@hot-updater/cli-tools", () => ({
  getBundleSigningPublicKey: vi.fn(async () => "configured public key"),
  getCwd: vi.fn(() => "/project"),
  loadConfig: vi.fn(async () => ({
    signing: { enabled: true, privateKeyPath: "./keys/private-key.pem" },
    platform: {
      ios: { infoPlistPaths: ["ios/App/Info.plist"] },
      android: {
        androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
      },
    },
  })),
}));
vi.mock("../../utils/expoDetection", () => ({ isExpoCNG: vi.fn() }));
vi.mock("../../utils/fingerprint", () => ({ syncFingerprintFiles: vi.fn() }));
vi.mock("../../utils/git", () => ({ isProjectFileTracked: vi.fn() }));
vi.mock("../keys", () => ({ writePublicKeyToNativeFiles: vi.fn() }));
vi.mock("./serverData", () => ({
  deleteUnreferencedArtifacts: vi.fn(),
  rebuildReleaseCatalogs: vi.fn(),
}));

const issues = (...codes: DoctorIssueCode[]) => codes.map((code) => ({ code }));

const IOS_PLIST = "ios/App/Info.plist";
const ANDROID_MANIFEST = "android/app/src/main/AndroidManifest.xml";

const fingerprints = {
  ios: { hash: "ios", sources: [] },
  android: { hash: "android", sources: [] },
};
const core = { name: "core" };

/** A doctor run's context: one server and one fingerprint. */
const context = (): DoctorContext => ({
  cwd: "/project",
  nonInteractive: true,
  server: vi.fn(async () => ({ core }) as never),
  managed: vi.fn(async () => null),
  fingerprints: vi.fn(async () => fingerprints),
  dispose: vi.fn(async () => {}),
});

describe("applyDoctorFixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isExpoCNG).mockReturnValue(false);
    vi.mocked(isProjectFileTracked).mockReturnValue(true);
  });

  it("writes the run's fingerprint once for all its issues", async () => {
    vi.mocked(syncFingerprintFiles).mockResolvedValue({
      fingerprintJson: true,
    });
    const run = context();

    const fixes = await applyDoctorFixes(
      issues("MISSING_FINGERPRINT_JSON", "FINGERPRINT_JSON_STALE"),
      run,
    );

    expect(fixes).toEqual([
      {
        repair: "fingerprint",
        codes: ["MISSING_FINGERPRINT_JSON", "FINGERPRINT_JSON_STALE"],
        status: "applied",
        wrote: ["fingerprint.json"],
        native: false,
      },
    ]);
    expect(syncFingerprintFiles).toHaveBeenCalledOnce();
    expect(syncFingerprintFiles).toHaveBeenCalledWith(fingerprints);
    expect(run.fingerprints).toHaveBeenCalledOnce();
  });

  it("asks for no native rebuild when only fingerprint.json changed", async () => {
    vi.mocked(syncFingerprintFiles).mockResolvedValue({
      fingerprintJson: true,
    });

    const fixes = await applyDoctorFixes(
      issues("MISSING_FINGERPRINT_JSON"),
      context(),
    );

    expect(fixes).toMatchObject([
      { status: "applied", wrote: ["fingerprint.json"], native: false },
    ]);
    expect(fixesWroteNativeFiles(fixes)).toBe(false);
  });

  it("writes the configured public key, and says installed apps keep a replaced one", async () => {
    vi.mocked(writePublicKeyToNativeFiles).mockResolvedValue([
      { platform: "android", paths: [ANDROID_MANIFEST], success: true },
      { platform: "ios", paths: [IOS_PLIST], success: true },
    ]);

    const [fix] = await applyDoctorFixes(
      issues("MISSING_PUBLIC_KEY", "PUBLIC_KEY_MISMATCH"),
      context(),
    );

    expect(writePublicKeyToNativeFiles).toHaveBeenCalledWith(
      "configured public key",
      expect.objectContaining({ platform: expect.any(Object) }),
    );
    expect(fix).toMatchObject({
      repair: "public-key",
      status: "applied",
      wrote: [ANDROID_MANIFEST, IOS_PLIST],
      native: true,
      note: expect.stringContaining(
        "Apps already installed keep the previous key",
      ),
    });
  });

  it("skips the public key when the project has no native files to hold it", async () => {
    vi.mocked(writePublicKeyToNativeFiles).mockResolvedValue([]);

    await expect(
      applyDoctorFixes(issues("MISSING_PUBLIC_KEY"), context()),
    ).resolves.toMatchObject([
      {
        repair: "public-key",
        status: "skipped",
        wrote: [],
        native: false,
        note: expect.stringContaining("no native files"),
      },
    ]);
  });

  it("never removes a public key: an issue with two remedies stays the user's", async () => {
    const fixes = await applyDoctorFixes(
      issues("ORPHAN_PUBLIC_KEY"),
      context(),
    );

    expect(fixes).toEqual([
      {
        repair: "orphan-public-key",
        codes: ["ORPHAN_PUBLIC_KEY"],
        status: "skipped",
        wrote: [],
        native: false,
        note: expect.stringContaining("never removes a public key"),
      },
    ]);
    expect(fixesWroteNativeFiles(fixes)).toBe(false);
  });

  it("never records a changed fingerprint engine: it leaves fingerprint.json to the user", async () => {
    const fixes = await applyDoctorFixes(
      issues("FINGERPRINT_ENGINE_CHANGED", "FINGERPRINT_JSON_STALE"),
      context(),
    );

    expect(fixes).toEqual([
      {
        repair: "fingerprint",
        codes: ["FINGERPRINT_JSON_STALE"],
        status: "skipped",
        wrote: [],
        native: false,
        note: expect.stringContaining("Resolve FINGERPRINT_ENGINE_CHANGED"),
      },
      {
        repair: "fingerprint-engine",
        codes: ["FINGERPRINT_ENGINE_CHANGED"],
        status: "skipped",
        wrote: [],
        native: false,
        note: expect.stringContaining("never rewrites fingerprint.json"),
      },
    ]);
    expect(syncFingerprintFiles).not.toHaveBeenCalled();
  });

  it("deletes the fingerprint.json an appVersion project's builds would embed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hot-updater-fix-"));
    await writeFile(path.join(cwd, "fingerprint.json"), "{}");
    try {
      const fixes = await applyDoctorFixes(issues("FINGERPRINT_JSON_UNUSED"), {
        ...context(),
        cwd,
      });

      expect(fixes).toEqual([
        {
          repair: "unused-fingerprint",
          codes: ["FINGERPRINT_JSON_UNUSED"],
          status: "applied",
          wrote: ["fingerprint.json"],
          native: true,
        },
      ]);
      expect(existsSync(path.join(cwd, "fingerprint.json"))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("skips native-file repairs on an Expo project whose native folders prebuild generates, judged in the run's directory", async () => {
    vi.mocked(isExpoCNG).mockReturnValue(true);
    vi.mocked(isProjectFileTracked).mockReturnValue(false);
    vi.mocked(rebuildReleaseCatalogs).mockResolvedValue([
      "release catalog v1:app-version:ios:cHJvZA, generation 4",
    ]);

    const fixes = await applyDoctorFixes(
      [
        { code: "MISSING_PUBLIC_KEY" },
        {
          code: "RELEASE_CATALOG_STALE",
          scopeKey: "v1:app-version:ios:cHJvZA",
        },
      ],
      context(),
    );

    expect(isExpoCNG).toHaveBeenCalledWith("/project");
    expect(isProjectFileTracked).toHaveBeenCalledWith({
      cwd: "/project",
      filePath: "ios",
    });
    expect(fixes).toMatchObject([
      {
        repair: "public-key",
        status: "skipped",
        note: expect.stringContaining("expo prebuild"),
      },
      { repair: "release-catalogs", status: "applied", native: false },
    ]);
    expect(writePublicKeyToNativeFiles).not.toHaveBeenCalled();
  });

  it("repairs fingerprint.json in an Expo project, which writes no native file", async () => {
    vi.mocked(isExpoCNG).mockReturnValue(true);
    vi.mocked(syncFingerprintFiles).mockResolvedValue({
      fingerprintJson: true,
    });

    await expect(
      applyDoctorFixes(issues("FINGERPRINT_JSON_STALE"), context()),
    ).resolves.toMatchObject([
      { status: "applied", wrote: ["fingerprint.json"], native: false },
    ]);
  });

  it("rebuilds each stale release catalog and deletes the unreferenced artifacts through the run's server", async () => {
    vi.mocked(rebuildReleaseCatalogs).mockResolvedValue([
      "release catalog v1:app-version:ios:cHJvZA, generation 4",
    ]);
    vi.mocked(deleteUnreferencedArtifacts).mockResolvedValue([
      "artifact record art-1",
      "artifact record art-2",
    ]);
    const run = context();

    const fixes = await applyDoctorFixes(
      [
        {
          code: "RELEASE_CATALOG_STALE",
          scopeKey: "v1:app-version:ios:cHJvZA",
        },
        {
          code: "RELEASE_CATALOG_IDENTITY_MISSING",
          scopeKey: "v1:app-version:ios:YmV0YQ",
        },
        {
          code: "UNREFERENCED_ARTIFACTS",
          artifactIds: ["art-1", "art-2"],
        },
      ],
      run,
    );

    expect(rebuildReleaseCatalogs).toHaveBeenCalledWith(core, [
      "v1:app-version:ios:cHJvZA",
    ]);
    expect(deleteUnreferencedArtifacts).toHaveBeenCalledWith(core, [
      "art-1",
      "art-2",
    ]);
    expect(fixes).toEqual([
      {
        repair: "release-catalogs",
        codes: ["RELEASE_CATALOG_STALE"],
        status: "applied",
        wrote: ["release catalog v1:app-version:ios:cHJvZA, generation 4"],
        native: false,
      },
      {
        repair: "unreferenced-artifacts",
        codes: ["UNREFERENCED_ARTIFACTS"],
        status: "applied",
        wrote: ["artifact record art-1", "artifact record art-2"],
        native: false,
      },
    ]);
    expect(run.dispose).not.toHaveBeenCalled();
  });

  it("reports a repair that failed, with each platform's error", async () => {
    vi.mocked(writePublicKeyToNativeFiles).mockResolvedValue([
      {
        platform: "ios",
        paths: [],
        success: false,
        error: "Info.plist is not writable",
      },
    ]);

    await expect(
      applyDoctorFixes(issues("MISSING_PUBLIC_KEY"), context()),
    ).resolves.toMatchObject([
      {
        repair: "public-key",
        status: "failed",
        wrote: [],
        native: false,
        note: "ios: Info.plist is not writable",
      },
    ]);
  });

  it("runs nothing for issues only a code edit repairs", async () => {
    await expect(
      applyDoctorFixes(
        issues("MISSING_CLIENT_PLUGIN", "MISSING_IOS_BUNDLE_PROVIDER"),
        context(),
      ),
    ).resolves.toEqual([]);
  });
});
