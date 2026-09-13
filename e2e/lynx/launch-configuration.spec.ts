import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveE2eLaunchConfiguration } from "../../examples/lynx/src/e2eApp/launchConfiguration";
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

  it("rejects non-HTTP launch endpoints", () => {
    expect(() =>
      resolveE2eLaunchConfiguration({
        runtimeConfigURL: "file:///tmp/runtime-config",
      }),
    ).toThrow("Lynx launch endpoint must use HTTP or HTTPS");
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
