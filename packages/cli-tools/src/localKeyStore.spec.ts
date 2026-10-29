import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLocalSecretsStore,
  getHotUpdaterHome,
  getLocalKeyStoreDir,
  getProjectKey,
  readLocalKey,
  resolveLocalSecretsPath,
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

const project = async (name: string, { git = false } = {}) => {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  if (git) execFileSync("git", ["init", "-q"], { cwd: directory });
  return directory;
};

const mode = async (target: string) => (await fs.stat(target)).mode & 0o777;

describe("localSecrets()'s default directory", () => {
  it("lives under HOT_UPDATER_HOME, else ~/.hot-updater", () => {
    expect(getHotUpdaterHome()).toBe(path.join(root, "home"));
    vi.stubEnv("HOT_UPDATER_HOME", "");
    expect(getHotUpdaterHome()).toBe(path.join(os.homedir(), ".hot-updater"));
  });

  it("keys each project by its directory: stable for one path, its own for every other checkout", async () => {
    const first = await project("my-app");
    const second = await project("clone/my-app");

    expect(getProjectKey(first)).toMatch(/^my-app-[0-9a-f]{12}$/u);
    expect(getProjectKey(first)).toBe(getProjectKey(first));
    expect(getProjectKey(second)).toMatch(/^my-app-[0-9a-f]{12}$/u);
    expect(getProjectKey(second)).not.toBe(getProjectKey(first));
    expect(getLocalKeyStoreDir(first)).toBe(
      path.join(root, "home", "secrets", getProjectKey(first)),
    );
  });

  it("writes 0600 files in 0700 directories outside the project, which survive its node_modules", async () => {
    const app = await project("survivor");
    await fs.mkdir(path.join(app, "node_modules", ".hot-updater"), {
      recursive: true,
    });

    const file = await writeLocalKey("asc-api-key", "value", app);
    await fs.rm(path.join(app, "node_modules"), {
      force: true,
      recursive: true,
    });

    expect(file).toBe(path.join(getLocalKeyStoreDir(app), "asc-api-key.json"));
    expect(path.relative(app, file).startsWith("..")).toBe(true);
    expect(await readLocalKey("asc-api-key", app)).toBe("value");
    if (process.platform !== "win32") {
      expect(await mode(file)).toBe(0o600);
      expect(await mode(path.dirname(file))).toBe(0o700);
    }
  });
});

describe("localSecrets({ path })", () => {
  it("expands ~ to the home directory, and resolves a relative path from the project", () => {
    expect(resolveLocalSecretsPath("~", "/project")).toBe(os.homedir());
    expect(resolveLocalSecretsPath("~/.secrets/app", "/project")).toBe(
      path.join(os.homedir(), ".secrets", "app"),
    );
    expect(resolveLocalSecretsPath(".secrets", "/project")).toBe(
      path.resolve("/project", ".secrets"),
    );
    expect(resolveLocalSecretsPath("/abs/dir", "/project")).toBe(
      path.resolve("/abs/dir"),
    );
  });

  it("stores in a relative directory git ignores, 0700 and 0600", async () => {
    const app = await project("ignored", { git: true });
    await fs.writeFile(path.join(app, ".gitignore"), ".secrets/\n");
    const store = createLocalSecretsStore({ path: ".secrets" });

    const file = await store.write("asc-api-key", "value", app);

    expect(file).toBe(path.join(app, ".secrets", "asc-api-key.json"));
    expect(await store.read("asc-api-key", app)).toBe("value");
    if (process.platform !== "win32") {
      expect(await mode(file)).toBe(0o600);
      expect(await mode(path.dirname(file))).toBe(0o700);
    }
  });

  it("refuses a directory in a git work tree that git does not ignore, writing nothing", async () => {
    const app = await project("committable", { git: true });
    const store = createLocalSecretsStore({ path: "secrets" });

    const refused = (await store.write("asc-api-key", "value", app).then(
      () => undefined,
      (error: unknown) => error,
    )) as Error;
    // Broken at spaces: a long path gets a line of its own.
    expect(refused.message.replaceAll("\n", " ")).toBe(
      [
        `localSecrets() refuses ${path.join(app, "secrets")}: its secrets could be committed.`,
        `The git repository ${app} doesn't ignore it.`,
        "Add secrets/ to its .gitignore, or set localSecrets({ path }).",
      ].join(" "),
    );
    expect(
      refused.message
        .split("\n")
        .filter((line) => line.length > 76 && line.includes(" ")),
    ).toEqual([]);
    await expect(store.read("asc-api-key", app)).rejects.toThrow(
      /could\s+be\s+committed/u,
    );
    await expect(fs.access(path.join(app, "secrets"))).rejects.toThrow();
  });

  it("refuses a path that exists and is no directory", async () => {
    const app = await project("file-path");
    await fs.writeFile(path.join(app, "secrets"), "");
    const store = createLocalSecretsStore({ path: "secrets" });

    const refused = (await store.write("asc-api-key", "value", app).then(
      () => undefined,
      (error: unknown) => error,
    )) as Error;
    expect(refused.message.replaceAll("\n", " ")).toBe(
      [
        `localSecrets() can't keep secrets in ${path.join(app, "secrets")}.`,
        "It is not a directory: set its path to one.",
      ].join(" "),
    );
    expect(
      refused.message
        .split("\n")
        .filter((line) => line.length > 76 && line.includes(" ")),
    ).toEqual([]);
  });

  it("stores outside any git work tree as it is", async () => {
    const app = await project("app", { git: true });
    const outside = path.join(root, "elsewhere");
    const store = createLocalSecretsStore({ path: outside });

    await store.write("asc-api-key", "value", app);

    expect(
      await fs.readFile(path.join(outside, "asc-api-key.json"), "utf-8"),
    ).toBe("value");
  });
});
