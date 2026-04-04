import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let projectRoot = "";

vi.mock("./cwd.js", () => ({
  getCwd: () => projectRoot,
}));

const writeProjectFile = async (
  rootDir: string,
  relativePath: string,
  contents: string,
) => {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
};

describe("loadConfig", () => {
  beforeEach(async () => {
    vi.resetModules();
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-load-config-"),
    );
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns defaults when the config file is missing", async () => {
    const { loadConfig } = await import("./loadConfig");

    const config = await loadConfig(null);

    expect(config.releaseChannel).toBe("production");
    expect(config.updateStrategy).toBe("appVersion");
    expect(config.compressStrategy).toBe("zip");
    expect(config.platform.android.stringResourcePaths).toEqual([]);
    expect(config.platform.ios.infoPlistPaths).toEqual([]);
    expect(config.console.port).toBe(1422);
  });

  it("discovers native config files from the project root by default", async () => {
    await writeProjectFile(
      projectRoot,
      "ios/HotUpdaterExample/Info.plist",
      "<plist />",
    );
    await writeProjectFile(
      projectRoot,
      "android/app/src/main/res/values/strings.xml",
      "<resources />",
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(config.platform.ios.infoPlistPaths).toEqual([
      "ios/HotUpdaterExample/Info.plist",
    ]);
    expect(config.platform.android.stringResourcePaths).toEqual([
      path.join(
        "android",
        "app",
        "src",
        "main",
        "res",
        "values",
        "strings.xml",
      ),
    ]);
  });

  it("passes null context through to function configs", async () => {
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "export default (options) => ({",
        "  releaseChannel: options === null ? 'from-null-context' : 'wrong',",
        "});",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig(null);

    expect(config.releaseChannel).toBe("from-null-context");
  });

  it("preserves legacy merge semantics for arrays in user config", async () => {
    await writeProjectFile(
      projectRoot,
      "ios/HotUpdaterExample/Info.plist",
      "<plist />",
    );
    await writeProjectFile(
      projectRoot,
      "android/app/src/main/res/values/strings.xml",
      "<resources />",
    );
    await writeProjectFile(
      projectRoot,
      "hot-updater.config.ts",
      [
        "export default (options) => ({",
        "  releaseChannel: options?.channel ?? 'staging',",
        "  updateStrategy: 'fingerprint',",
        "  console: {",
        "    port: 3001,",
        "  },",
        "  fingerprint: {",
        "    extraSources: ['src/custom.ts'],",
        "  },",
        "  platform: {",
        "    android: {",
        "      stringResourcePaths: ['android/custom/strings.xml'],",
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    const { loadConfig } = await import("./loadConfig");
    const config = await loadConfig({ platform: "android", channel: "beta" });

    expect(config.releaseChannel).toBe("beta");
    expect(config.updateStrategy).toBe("fingerprint");
    expect(config.console.port).toBe(3001);
    expect(config.fingerprint.extraSources).toEqual(["src/custom.ts"]);
    expect(config.platform.android.stringResourcePaths).toEqual([
      "android/custom/strings.xml",
    ]);
    expect(config.platform.ios.infoPlistPaths).toEqual([
      "ios/HotUpdaterExample/Info.plist",
    ]);
  });
});
