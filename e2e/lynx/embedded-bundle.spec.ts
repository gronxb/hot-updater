import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LYNX_E2E_BUILTIN_BUNDLE_ID,
  packageLynxEmbeddedDirectory,
  rewriteLynxAndroidEmulatorUrl,
} from "./embedded-bundle.ts";

describe("Lynx E2E embedded bundle packaging", () => {
  it("writes a native-verifiable manifest for the builtin tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-e2e-embed-"));
    try {
      await fs.writeFile(path.join(root, "main.lynx.bundle"), "bundle-bytes");
      const result = await packageLynxEmbeddedDirectory({
        root,
        platform: "ios",
        bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
        runtimeId: "test-runtime",
      });
      const manifest = JSON.parse(
        await fs.readFile(path.join(root, "manifest.json"), "utf8"),
      ) as {
        bundleId: string;
        assets: Record<string, { fileHash: string }>;
      };
      const metadata = JSON.parse(
        await fs.readFile(path.join(root, "hot-updater-lynx.json"), "utf8"),
      ) as { bundleId: string; entry: string; platform: string };
      const bundleHash = createHash("sha256")
        .update("bundle-bytes")
        .digest("hex");
      expect(manifest.bundleId).toBe(LYNX_E2E_BUILTIN_BUNDLE_ID);
      expect(manifest.assets["main.lynx.bundle"]?.fileHash).toBe(bundleHash);
      expect(manifest.assets["hot-updater-lynx.json"]).toBeDefined();
      expect(manifest.assets["manifest.json"]).toBeUndefined();
      expect(metadata).toMatchObject({
        bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
        entry: "main.lynx.bundle",
        platform: "ios",
      });
      expect(result.manifestDigest).toBe(
        createHash("sha256")
          .update(await fs.readFile(path.join(root, "manifest.json")))
          .digest("hex"),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("rewriteLynxAndroidEmulatorUrl", () => {
  it("rewrites localhost control URLs to the emulator host port", () => {
    expect(
      rewriteLynxAndroidEmulatorUrl(
        "http://localhost:3107/e2e/runtime-config",
        {
          HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT: "3107",
          HOT_UPDATER_E2E_CONTROL_PORT: "3108",
        },
      ),
    ).toBe("http://10.0.2.2:3108/e2e/runtime-config");
  });

  it("rewrites 127.0.0.1 app URLs without changing a host provider port", () => {
    expect(
      rewriteLynxAndroidEmulatorUrl("http://127.0.0.1:3008/hot-updater", {
        HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT: "3107",
        PORT: "3108",
      }),
    ).toBe("http://10.0.2.2:3008/hot-updater");
  });
});
