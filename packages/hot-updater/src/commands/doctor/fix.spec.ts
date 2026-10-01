import { beforeEach, describe, expect, it, vi } from "vitest";

import { isExpoCNG } from "../../utils/expoDetection";
import { createAndInjectFingerprintFiles } from "../../utils/fingerprint";
import { isProjectFileTracked } from "../../utils/git";
import {
  removePublicKeyFromNativeFiles,
  writePublicKeyToNativeFiles,
} from "../keys";
import { applyDoctorFixes } from "./fix";
import { type DoctorIssueCode, fixesWroteNativeFiles } from "./issues";
import { rebuildReleaseCatalogs } from "./releaseCatalogs";

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
vi.mock("../../utils/fingerprint", () => ({
  createAndInjectFingerprintFiles: vi.fn(),
}));
vi.mock("../../utils/git", () => ({ isProjectFileTracked: vi.fn() }));
vi.mock("../keys", () => ({
  removePublicKeyFromNativeFiles: vi.fn(),
  writePublicKeyToNativeFiles: vi.fn(),
}));
vi.mock("./releaseCatalogs", () => ({ rebuildReleaseCatalogs: vi.fn() }));

const issues = (...codes: DoctorIssueCode[]) => codes.map((code) => ({ code }));

const IOS_PLIST = "ios/App/Info.plist";
const ANDROID_MANIFEST = "android/app/src/main/AndroidManifest.xml";

describe("applyDoctorFixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isExpoCNG).mockReturnValue(false);
    vi.mocked(isProjectFileTracked).mockReturnValue(true);
  });

  it("recreates the fingerprint once for all its issues and names every file it wrote", async () => {
    vi.mocked(createAndInjectFingerprintFiles).mockResolvedValue({
      fingerprint: {
        ios: { hash: "ios", sources: [] },
        android: { hash: "android", sources: [] },
      },
      iosPaths: [IOS_PLIST],
      androidPaths: [ANDROID_MANIFEST],
    });

    const fixes = await applyDoctorFixes(
      issues(
        "MISSING_FINGERPRINT_HASH",
        "FINGERPRINT_HASH_MISMATCH",
        "FINGERPRINT_JSON_STALE",
      ),
      { cwd: "/project" },
    );

    expect(fixes).toEqual([
      {
        repair: "fingerprint",
        codes: [
          "MISSING_FINGERPRINT_HASH",
          "FINGERPRINT_HASH_MISMATCH",
          "FINGERPRINT_JSON_STALE",
        ],
        native: true,
        status: "applied",
        wrote: ["fingerprint.json", IOS_PLIST, ANDROID_MANIFEST],
      },
    ]);
    expect(createAndInjectFingerprintFiles).toHaveBeenCalledOnce();
    expect(fixesWroteNativeFiles(fixes)).toBe(true);
  });

  it("writes the configured public key, and says installed apps keep a replaced one", async () => {
    vi.mocked(writePublicKeyToNativeFiles).mockResolvedValue([
      { platform: "android", paths: [ANDROID_MANIFEST], success: true },
      { platform: "ios", paths: [IOS_PLIST], success: true },
    ]);

    const [fix] = await applyDoctorFixes(
      issues("MISSING_PUBLIC_KEY", "PUBLIC_KEY_MISMATCH"),
      { cwd: "/project" },
    );

    expect(writePublicKeyToNativeFiles).toHaveBeenCalledWith(
      "configured public key",
      expect.objectContaining({ platform: expect.any(Object) }),
    );
    expect(fix).toMatchObject({
      repair: "public-key",
      status: "applied",
      wrote: [ANDROID_MANIFEST, IOS_PLIST],
      note: expect.stringContaining(
        "Apps already installed keep the previous key",
      ),
    });
  });

  it("removes an orphan public key from the native files", async () => {
    vi.mocked(removePublicKeyFromNativeFiles).mockResolvedValue([
      { platform: "ios", paths: [IOS_PLIST], success: true, found: true },
    ]);

    await expect(
      applyDoctorFixes(issues("ORPHAN_PUBLIC_KEY"), { cwd: "/project" }),
    ).resolves.toEqual([
      {
        repair: "orphan-public-key",
        codes: ["ORPHAN_PUBLIC_KEY"],
        native: true,
        status: "applied",
        wrote: [IOS_PLIST],
      },
    ]);
  });

  it("skips native-file repairs on an Expo project whose native folders prebuild generates", async () => {
    vi.mocked(isExpoCNG).mockReturnValue(true);
    vi.mocked(isProjectFileTracked).mockReturnValue(false);

    const fixes = await applyDoctorFixes(
      issues("FINGERPRINT_JSON_STALE", "ORPHAN_PUBLIC_KEY"),
      { cwd: "/project" },
    );

    expect(fixes).toMatchObject([
      {
        repair: "fingerprint",
        status: "skipped",
        wrote: [],
        note: expect.stringContaining("expo prebuild"),
      },
      { repair: "orphan-public-key", status: "skipped", wrote: [] },
    ]);
    expect(createAndInjectFingerprintFiles).not.toHaveBeenCalled();
    expect(removePublicKeyFromNativeFiles).not.toHaveBeenCalled();
    expect(fixesWroteNativeFiles(fixes)).toBe(false);
  });

  it("repairs the native files of an Expo project that commits them", async () => {
    vi.mocked(isExpoCNG).mockReturnValue(true);
    vi.mocked(removePublicKeyFromNativeFiles).mockResolvedValue([
      {
        platform: "android",
        paths: [ANDROID_MANIFEST],
        success: true,
        found: true,
      },
    ]);

    await expect(
      applyDoctorFixes(issues("ORPHAN_PUBLIC_KEY"), { cwd: "/project" }),
    ).resolves.toMatchObject([
      { status: "applied", wrote: [ANDROID_MANIFEST] },
    ]);
  });

  it("reports a repair that failed, with each platform's error", async () => {
    vi.mocked(writePublicKeyToNativeFiles).mockResolvedValue([
      {
        platform: "ios",
        paths: [],
        success: false,
        error: "No Info.plist files found",
      },
    ]);

    await expect(
      applyDoctorFixes(issues("MISSING_PUBLIC_KEY"), { cwd: "/project" }),
    ).resolves.toMatchObject([
      {
        repair: "public-key",
        status: "failed",
        wrote: [],
        note: "ios: No Info.plist files found",
      },
    ]);
  });

  it("runs nothing for issues only a code edit repairs", async () => {
    await expect(
      applyDoctorFixes(
        issues("MISSING_CLIENT_PLUGIN", "MISSING_IOS_BUNDLE_PROVIDER"),
        { cwd: "/project" },
      ),
    ).resolves.toEqual([]);
  });

  it("rebuilds each stale release catalog, on an Expo project too, since it writes no native file", async () => {
    vi.mocked(isExpoCNG).mockReturnValue(true);
    vi.mocked(isProjectFileTracked).mockReturnValue(false);
    vi.mocked(rebuildReleaseCatalogs).mockResolvedValue([
      "release catalog v1:app-version:ios:cHJvZA, generation 4",
    ]);

    const fixes = await applyDoctorFixes(
      [
        {
          code: "RELEASE_CATALOG_STALE",
          scopeKey: "v1:app-version:ios:cHJvZA",
        },
        {
          code: "RELEASE_CATALOG_STALE",
          scopeKey: "v1:app-version:android:cHJvZA",
        },
        {
          code: "RELEASE_CATALOG_IDENTITY_MISSING",
          scopeKey: "v1:app-version:ios:YmV0YQ",
        },
      ],
      { cwd: "/project" },
    );

    expect(rebuildReleaseCatalogs).toHaveBeenCalledWith(expect.anything(), [
      "v1:app-version:ios:cHJvZA",
      "v1:app-version:android:cHJvZA",
    ]);
    expect(fixes).toEqual([
      {
        repair: "release-catalogs",
        codes: ["RELEASE_CATALOG_STALE"],
        native: false,
        status: "applied",
        wrote: ["release catalog v1:app-version:ios:cHJvZA, generation 4"],
      },
    ]);
    expect(fixesWroteNativeFiles(fixes)).toBe(false);
  });
});
