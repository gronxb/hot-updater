import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getHotUpdaterHome,
  getLocalKeyStoreDir,
  getProjectIdentity,
  getProjectKey,
  normalizeRemoteUrl,
  readLocalKey,
  writeLocalKey,
} from "./localKeyStore";

let root: string;

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-key-store-")),
  );
  vi.stubEnv("HOT_UPDATER_HOME", path.join(root, "home"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { force: true, recursive: true });
});

const clone = async (name: string, remote?: string) => {
  const directory = path.join(root, name);
  await fs.mkdir(path.join(directory, "apps", "mobile"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: directory });
  if (remote) {
    execFileSync("git", ["remote", "add", "origin", remote], {
      cwd: directory,
    });
  }
  return directory;
};

describe("the local key store", () => {
  it("lives under HOT_UPDATER_HOME, else ~/.hot-updater", () => {
    expect(getHotUpdaterHome()).toBe(path.join(root, "home"));
    vi.stubEnv("HOT_UPDATER_HOME", "");
    expect(getHotUpdaterHome()).toBe(path.join(os.homedir(), ".hot-updater"));
  });

  it.each([
    ["https://github.com/Owner/App.git", "github.com/Owner/App"],
    ["https://token@GitHub.com/Owner/App/", "github.com/Owner/App"],
    ["git@github.com:Owner/App.git", "github.com/Owner/App"],
    ["ssh://git@github.com/Owner/App.git", "github.com/Owner/App"],
    ["ssh://git@gitlab.example.com:2222/a/b.git", "gitlab.example.com:2222/a/b"],
  ])("normalizes the remote %s", (url, normalized) => {
    expect(normalizeRemoteUrl(url)).toBe(normalized);
  });

  it("gives every clone of one app the same project key, and another app its own", async () => {
    const first = await clone("first", "https://github.com/owner/app.git");
    const second = await clone("second", "git@github.com:owner/app.git");
    const fork = await clone("fork", "git@github.com:someone/app.git");

    expect(getProjectIdentity(path.join(first, "apps", "mobile"))).toBe(
      "git:github.com/owner/app#apps/mobile",
    );
    expect(getProjectKey(first)).toMatch(/^app-[0-9a-f]{12}$/u);
    expect(getProjectKey(second)).toBe(getProjectKey(first));
    expect(getProjectKey(path.join(second, "apps", "mobile"))).toBe(
      getProjectKey(path.join(first, "apps", "mobile")),
    );
    expect(getProjectKey(path.join(first, "apps", "mobile"))).not.toBe(
      getProjectKey(first),
    );
    expect(getProjectKey(fork)).not.toBe(getProjectKey(first));
  });

  it("keys a project without an origin remote by its directory", async () => {
    const local = await clone("local-only");

    expect(getProjectIdentity(local)).toBe(`path:${local}`);
    expect(getProjectKey(local)).toMatch(/^local-only-[0-9a-f]{12}$/u);
  });

  it("survives the project's node_modules", async () => {
    const project = await clone("survivor", "https://github.com/owner/survivor");
    await fs.mkdir(path.join(project, "node_modules", ".hot-updater"), {
      recursive: true,
    });

    const file = await writeLocalKey("asc-api-key", "value", project);
    await fs.rm(path.join(project, "node_modules"), {
      force: true,
      recursive: true,
    });

    expect(file.startsWith(getLocalKeyStoreDir(project))).toBe(true);
    expect(path.relative(project, file).startsWith("..")).toBe(true);
    expect(await readLocalKey("asc-api-key", project)).toBe("value");
  });
});
