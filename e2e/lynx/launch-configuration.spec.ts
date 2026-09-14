import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  readE2eLaunchConfiguration,
  resolveE2eLaunchConfiguration,
} from "../../examples/lynx/src/e2eApp/launchConfiguration";
import {
  resolveAppBaseUrl,
  resolveRuntimeConfigUrl,
} from "../detox/scripts/control-server-env.ts";
import {
  createLynxNativeLaunchConfiguration,
  serializeLynxNativeLaunchConfiguration,
} from "./native-launch-configuration.ts";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("Lynx E2E launch configuration", () => {
  it("uses the endpoints supplied for the current device shard", () => {
    expect(
      resolveE2eLaunchConfiguration({
        runtimeConfigURL: "http://localhost:3114/e2e/runtime-config",
        appBaseURL: "http://127.0.0.1:3014/hot-updater",
      }),
    ).toEqual({
      runtimeConfigURL: "http://localhost:3114/e2e/runtime-config",
      appBaseURL: "http://127.0.0.1:3014/hot-updater",
    });
  });

  it.each([
    "file:///tmp/runtime-config",
    "http://user:password@localhost/runtime-config",
    "http://localhost:65536/runtime-config",
    "http://localhost/runtime config",
    "http://localhost\\runtime-config",
  ])("rejects an unsafe launch endpoint %s", (runtimeConfigURL) => {
    expect(() => resolveE2eLaunchConfiguration({ runtimeConfigURL })).toThrow(
      "Lynx launch endpoint must use HTTP or HTTPS",
    );
  });

  it.each([
    undefined,
    class PartialURL {
      toString() {
        return "http://wrong.test";
      }
    },
  ])(
    "does not depend on a missing or partial WHATWG URL implementation %#",
    (urlImplementation) => {
      const originalURL = globalThis.URL;
      globalThis.URL = urlImplementation as typeof URL;
      try {
        expect(
          resolveE2eLaunchConfiguration({
            runtimeConfigURL: "http://localhost:3114/e2e/runtime-config",
            appBaseURL: "https://updates.test/hot-updater",
          }),
        ).toEqual({
          runtimeConfigURL: "http://localhost:3114/e2e/runtime-config",
          appBaseURL: "https://updates.test/hot-updater",
        });
      } finally {
        globalThis.URL = originalURL;
      }
    },
  );

  it("does not read the background-only bridge in the main rendering realm", async () => {
    const readNativeConfiguration = vi.fn(async () => ({
      appBaseURL: "https://updates.test/hot-updater",
      runtimeConfigURL: "http://localhost:3114/e2e/runtime-config",
    }));

    await expect(
      readE2eLaunchConfiguration(false, readNativeConfiguration),
    ).resolves.toBeNull();
    expect(readNativeConfiguration).not.toHaveBeenCalled();
  });

  it("reads and validates launch configuration in the background realm", async () => {
    const readNativeConfiguration = vi.fn(async () => ({
      appBaseURL: "https://updates.test/hot-updater",
      runtimeConfigURL: "http://localhost:3114/e2e/runtime-config",
    }));

    await expect(
      readE2eLaunchConfiguration(true, readNativeConfiguration),
    ).resolves.toEqual({
      appBaseURL: "https://updates.test/hot-updater",
      runtimeConfigURL: "http://localhost:3114/e2e/runtime-config",
    });
    expect(readNativeConfiguration).toHaveBeenCalledOnce();
  });

  it("resolves the actual bot child environment without requiring derived server-only keys", () => {
    const env = {
      HOT_UPDATER_CONTROL_BASE_URL: "http://127.0.0.1:3014/hot-updater",
      HOT_UPDATER_E2E_CONTROL_PORT: "3114",
    };
    expect(resolveAppBaseUrl(env)).toBe("http://127.0.0.1:3014/hot-updater");
    expect(resolveRuntimeConfigUrl("ios", env)).toBe(
      "http://localhost:3114/e2e/runtime-config",
    );
    expect(resolveRuntimeConfigUrl("android", env)).toBe(
      "http://localhost:3107/e2e/runtime-config",
    );
  });

  it("serializes the per-context configuration consumed by both native hosts", () => {
    expect(
      serializeLynxNativeLaunchConfiguration(
        createLynxNativeLaunchConfiguration({
          appBaseURL: "http://127.0.0.1:3014/hot-updater",
          runtimeConfigURL: "http://localhost:3114/e2e/runtime-config",
        }),
      ),
    ).toBe(
      '{"appBaseURL":"http://127.0.0.1:3014/hot-updater","runtimeConfigURL":"http://localhost:3114/e2e/runtime-config"}',
    );
  });

  it("carries the launch generation from the native driver into E2E JS", () => {
    const nativeConfiguration = createLynxNativeLaunchConfiguration({
      appBaseURL: "http://127.0.0.1:3014/hot-updater",
      launchGeneration: "launch-123",
      runtimeConfigURL: "http://localhost:3114/e2e/runtime-config",
    });

    expect(resolveE2eLaunchConfiguration(nativeConfiguration)).toMatchObject({
      launchGeneration: "launch-123",
    });
    expect(
      serializeLynxNativeLaunchConfiguration(nativeConfiguration),
    ).toContain('"launchGeneration":"launch-123"');
  });

  it("keeps every public framework bundle independent of shard endpoints", () => {
    const files = [
      "examples/lynx/e2e.lynx.config.ts",
      "examples/lynx/react/lynx.config.ts",
      "examples/lynx/vue/lynx.config.ts",
      "examples/lynx/octane/lynx.config.mjs",
      "examples/lynx/scripts/build-public.mjs",
      "examples/lynx/scripts/build.mjs",
      "examples/lynx/scripts/build-spike.mjs",
      "examples/lynx/scripts/build-octane.mjs",
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.join(repo, file), "utf8");
      expect(source, file).not.toContain("__SDK_BASE_URL__");
      expect(source, file).not.toContain("__E2E_APP_BASE_URL__");
      expect(source, file).not.toContain("__E2E_RUNTIME_CONFIG_URL__");
    }
  });
});
