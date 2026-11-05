import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPackageManager } from "./getPackageManager";

const NPX_USER_AGENT = "npm/10.9.2 node/v24.22.1 darwin arm64 workspaces/false";

describe("getPackageManager", () => {
  const userAgent = process.env["npm_config_user_agent"];
  let root: string;
  let app: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-pm-"));
    app = path.join(root, "apps", "mobile");
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(
      path.join(app, "package.json"),
      JSON.stringify({ dependencies: { shared: "workspace:*" } }),
    );
  });

  afterEach(async () => {
    if (userAgent === undefined) {
      delete process.env["npm_config_user_agent"];
    } else {
      process.env["npm_config_user_agent"] = userAgent;
    }
    await fs.rm(root, { force: true, recursive: true });
  });

  it("uses the workspace's lockfile over the CLI that ran init", async () => {
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "");
    process.env["npm_config_user_agent"] = NPX_USER_AGENT;

    expect(getPackageManager(app)).toBe("pnpm");
  });

  it("uses the lockfile when nothing names a package manager", async () => {
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "");
    delete process.env["npm_config_user_agent"];

    expect(getPackageManager(app)).toBe("pnpm");
  });

  it("uses the packageManager field over a lockfile", async () => {
    await fs.writeFile(path.join(root, "yarn.lock"), "");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "bun@1.3.0" }),
    );
    process.env["npm_config_user_agent"] = NPX_USER_AGENT;

    expect(getPackageManager(app)).toBe("bun");
  });

  it("uses the CLI that ran init without a lockfile or packageManager", () => {
    process.env["npm_config_user_agent"] = "yarn/4.9.1 npm/? node/v24.22.1";

    expect(getPackageManager(app)).toBe("yarn");
  });

  it("falls back to npm", () => {
    delete process.env["npm_config_user_agent"];

    expect(getPackageManager(app)).toBe("npm");
  });
});
