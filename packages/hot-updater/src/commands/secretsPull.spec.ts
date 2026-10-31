import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import {
  getBuildSecretNames,
  getDeploySecretNames,
  loadConfig,
  localSecrets,
  nonInteractiveReason,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSecretsImport } from "./secrets";
import { handleSecretsPull } from "./secretsPull";

const CANCEL = Symbol("cancel");

const { confirm, log, printBanner } = vi.hoisted(() => ({
  confirm: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  printBanner: vi.fn(),
}));

// Only the config, the terminal check, the prompt, and the log are mocked.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getBuildSecretNames: vi.fn(),
  getDeploySecretNames: vi.fn(),
  loadConfig: vi.fn(),
  nonInteractiveReason: vi.fn(),
  p: {
    confirm,
    isCancel: (value: unknown) => typeof value === "symbol",
    log,
  },
}));

vi.mock("@/utils/printBanner", () => ({ printBanner }));

/** A team store holding `values`, which only reads what it's asked for. */
const teamStore = (values: Record<string, string> = {}) => {
  const held = new Map(Object.entries(values));
  const store = {
    name: "teamStore",
    get: vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(names.map((name) => [name, held.get(name)])),
    ),
    set: vi.fn(async (name: string, value: string) => {
      held.set(name, value);
    }),
  } satisfies SecretsAdapter;
  return { store, held };
};

const configure = (
  secrets: SecretsAdapter | undefined,
  {
    deploy = [],
    build = [],
  }: {
    readonly deploy?: readonly string[];
    readonly build?: readonly string[];
  } = {},
) => {
  vi.mocked(loadConfig).mockResolvedValue({
    secrets: secrets ?? localSecrets(),
  } as never);
  vi.mocked(getDeploySecretNames).mockReturnValue(deploy);
  vi.mocked(getBuildSecretNames).mockReturnValue(build);
};

const allOutput = () =>
  [
    ...log.error.mock.calls,
    ...log.info.mock.calls,
    ...log.message.mock.calls,
    ...log.success.mock.calls,
    ...log.warn.mock.calls,
    ...confirm.mock.calls.map(([options]) => [JSON.stringify(options)]),
  ]
    .map(([message]) => String(message))
    .join("\n");

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  expect(result.status).toBe(0);
};

const SECRET_VALUE = "s3cr3t-value-of-the-store";

let directory: string;
const envFile = (file = ".env.hotupdater") => path.join(directory, file);
const readEnv = async (file?: string) =>
  parseEnv(await fs.readFile(envFile(file), "utf8"));
const modeOf = async (file?: string) =>
  (await fs.stat(envFile(file))).mode & 0o777;

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-pull-"));
  await fs.writeFile(path.join(directory, "package.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  vi.mocked(nonInteractiveReason).mockReturnValue("without a terminal");
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("hot-updater secrets pull", () => {
  it("creates a 0600 file of what the store holds, under the variables secret() and import read", async () => {
    const { store } = teamStore({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: SECRET_VALUE,
      "r2-keys": "r2 value",
      HOT_UPDATER_API_KEY: "app-api-key",
      UNREFERENCED: "never asked for",
    });
    configure(store, {
      deploy: ["HOT_UPDATER_CLOUDFLARE_API_TOKEN", "r2-keys"],
    });

    await handleSecretsPull();

    expect(process.exitCode).toBeUndefined();
    expect(await readEnv()).toEqual({
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: SECRET_VALUE,
      HOT_UPDATER_R2_KEYS: "r2 value",
      HOT_UPDATER_API_KEY: "app-api-key",
    });
    expect(await modeOf()).toBe(0o600);
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.set).not.toHaveBeenCalled();
    expect(log.success).toHaveBeenCalledWith(
      [
        "Pulled from teamStore to .env.hotupdater",
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
        "HOT_UPDATER_R2_KEYS",
        "HOT_UPDATER_API_KEY",
      ].join("\n"),
    );
    expect(allOutput()).not.toContain(SECRET_VALUE);
    expect(allOutput()).not.toContain("r2 value");
  });

  it("mirrors import: what it pulls, import stores back as the same values", async () => {
    const values = {
      HOT_UPDATER_CLOUDFLARE_API_TOKEN: SECRET_VALUE,
      JSON_VALUE: '{"a":"b","c":"it\'s"}',
      PEM_VALUE: "-----BEGIN KEY-----\nabc=\n-----END KEY-----",
      HOT_UPDATER_API_KEY: "app-api-key",
    };
    const deploy = Object.keys(values).filter(
      (name) => name !== "HOT_UPDATER_API_KEY",
    );
    configure(teamStore(values).store, { deploy });
    await handleSecretsPull();
    expect(process.exitCode).toBeUndefined();

    const other = teamStore();
    configure(other.store, { deploy });
    await handleSecretsImport();

    expect(process.exitCode).toBeUndefined();
    expect(Object.fromEntries(other.held)).toEqual(values);
  });

  it("merges with an existing file, keeping other lines and comments", async () => {
    const { store } = teamStore({ TOKEN: SECRET_VALUE });
    configure(store, { deploy: ["TOKEN"] });
    const content = [
      "# Infisical sign-in",
      "INFISICAL_TOKEN=keep-me # inline",
      "",
      "OTHER='keep too'",
    ].join("\n");
    await fs.writeFile(envFile(), content, { mode: 0o644 });

    await handleSecretsPull();

    expect(await fs.readFile(envFile(), "utf8")).toBe(
      `${content}\nTOKEN=${SECRET_VALUE}\n`,
    );
    expect(await modeOf()).toBe(0o600);
  });

  it("writes where --out says, relative to the project, making its directory", async () => {
    const { store } = teamStore({ TOKEN: SECRET_VALUE });
    configure(store, { deploy: ["TOKEN"] });

    await handleSecretsPull({ out: "env/.env.pulled" });

    expect(await readEnv("env/.env.pulled")).toEqual({ TOKEN: SECRET_VALUE });
    expect(await modeOf("env/.env.pulled")).toBe(0o600);
    expect(log.success.mock.calls[0]?.[0]).toContain("env/.env.pulled");
  });

  it("changes nothing for a value that matches, but still makes the file 0600", async () => {
    const { store } = teamStore({ TOKEN: SECRET_VALUE });
    configure(store, { deploy: ["TOKEN"] });
    const content = `export TOKEN='${SECRET_VALUE}' # mine\n`;
    await fs.writeFile(envFile(), content, { mode: 0o644 });

    await handleSecretsPull();

    expect(process.exitCode).toBeUndefined();
    expect(await fs.readFile(envFile(), "utf8")).toBe(content);
    expect(await modeOf()).toBe(0o600);
    expect(confirm).not.toHaveBeenCalled();
    expect(log.success).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("Already in .env.hotupdater\nTOKEN");
  });

  it("trims a value as import stores it, so it never differs from itself", async () => {
    const { store } = teamStore({ TOKEN: `${SECRET_VALUE}\n` });
    configure(store, { deploy: ["TOKEN"] });
    await fs.writeFile(envFile(), `TOKEN=${SECRET_VALUE}\n`);

    await handleSecretsPull();

    expect(process.exitCode).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith("Already in .env.hotupdater\nTOKEN");
  });

  it("refuses a differing value without a terminal, writing nothing, even for the names that are new", async () => {
    const { store } = teamStore({ TOKEN: SECRET_VALUE, NEW: "new" });
    configure(store, { deploy: ["TOKEN", "NEW"] });
    const content = "TOKEN=local-value\n";
    await fs.writeFile(envFile(), content);

    await handleSecretsPull();

    expect(process.exitCode).toBe(1);
    expect(await fs.readFile(envFile(), "utf8")).toBe(content);
    expect(confirm).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      [
        ".env.hotupdater holds another value for TOKEN.",
        "Can't ask without a terminal. Pass --force to replace it.",
        "Nothing was written.",
      ].join("\n"),
    );
    expect(allOutput()).not.toContain(SECRET_VALUE);
    expect(allOutput()).not.toContain("local-value");
  });

  it("replaces a differing value with --force, without asking", async () => {
    const { store } = teamStore({ TOKEN: SECRET_VALUE });
    configure(store, { deploy: ["TOKEN"] });
    await fs.writeFile(envFile(), "# mine\nTOKEN=local-value\nOTHER=1\n");
    vi.mocked(nonInteractiveReason).mockReturnValue(undefined);

    await handleSecretsPull({ force: true });

    expect(process.exitCode).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(await fs.readFile(envFile(), "utf8")).toBe(
      `# mine\nTOKEN=${SECRET_VALUE}\nOTHER=1\n`,
    );
  });

  it("asks at a terminal for each differing value, and keeps a declined one", async () => {
    const { store } = teamStore({ A: "store-a", B: "store-b", C: "store-c" });
    configure(store, { deploy: ["A", "B", "C"] });
    await fs.writeFile(envFile(), "A=local-a\nB=local-b\n");
    vi.mocked(nonInteractiveReason).mockReturnValue(undefined);
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await handleSecretsPull();

    expect(process.exitCode).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ initialValue: false });
    expect(await readEnv()).toEqual({
      A: "local-a",
      B: "store-b",
      C: "store-c",
    });
    expect(log.info).toHaveBeenCalledWith(
      "Kept your value in .env.hotupdater\nA",
    );
    expect(allOutput()).not.toMatch(/store-[abc]|local-[ab]/u);
  });

  it("writes nothing when a prompt is cancelled", async () => {
    const { store } = teamStore({ A: "store-a", C: "store-c" });
    configure(store, { deploy: ["A", "C"] });
    await fs.writeFile(envFile(), "A=local-a\n");
    vi.mocked(nonInteractiveReason).mockReturnValue(undefined);
    confirm.mockResolvedValueOnce(CANCEL);

    await handleSecretsPull();

    expect(process.exitCode).toBe(1);
    expect(await fs.readFile(envFile(), "utf8")).toBe("A=local-a\n");
  });

  it("writes nothing when the file changes during a prompt", async () => {
    const { store } = teamStore({ A: "store-a" });
    configure(store, { deploy: ["A"] });
    await fs.writeFile(envFile(), "A=local-a\n");
    vi.mocked(nonInteractiveReason).mockReturnValue(undefined);
    confirm.mockImplementationOnce(async () => {
      await fs.writeFile(envFile(), "A=edited\n");
      return true;
    });

    await handleSecretsPull();

    expect(process.exitCode).toBe(1);
    expect(await fs.readFile(envFile(), "utf8")).toBe("A=edited\n");
    expect(log.error).toHaveBeenCalledWith(
      ".env.hotupdater changed while asking.\nRun this again.",
    );
  });

  it("fills an empty value without asking: there is nothing to lose", async () => {
    const { store } = teamStore({ A: "store-a" });
    configure(store, { deploy: ["A"] });
    await fs.writeFile(envFile(), "A=\n");

    await handleSecretsPull();

    expect(process.exitCode).toBeUndefined();
    expect(await readEnv()).toEqual({ A: "store-a" });
  });

  it("never reads build credentials, and names them in one line", async () => {
    const { store } = teamStore({
      TOKEN: SECRET_VALUE,
      "asc-api-key": '{"keyId":"K"}',
      "release-keystore": '{"keystore":"AA=="}',
      "bundle-signing-key": "-----BEGIN PRIVATE KEY-----",
    });
    configure(store, {
      deploy: ["TOKEN", "play-service-account"],
      build: ["asc-api-key", "release-keystore", "bundle-signing-key"],
    });

    await handleSecretsPull();

    expect(process.exitCode).toBeUndefined();
    expect(store.get).toHaveBeenCalledWith(
      ["TOKEN", "HOT_UPDATER_API_KEY"],
      expect.anything(),
    );
    expect(await readEnv()).toEqual({ TOKEN: SECRET_VALUE });
    expect(String(log.info.mock.calls[0]?.[0]).replace(/\s+/gu, " ")).toBe(
      "Skipped asc-api-key, release-keystore, bundle-signing-key, and play-service-account. Builds read build credentials from the store.",
    );
  });

  it("says nothing to pull with localSecrets(), and exits 0 without reading it", async () => {
    configure(undefined, { deploy: ["TOKEN"] });

    await handleSecretsPull({ only: ["TOKEN"] });

    expect(process.exitCode).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      "localSecrets() keeps secrets on this machine: nothing to pull.",
    );
    await expect(fs.stat(envFile())).rejects.toThrow(/ENOENT/u);
  });

  it("names what the store lacks of the config's names, and not the app's API key", async () => {
    const { store } = teamStore({ TOKEN: SECRET_VALUE });
    configure(store, { deploy: ["TOKEN", "ABSENT"] });

    await handleSecretsPull();

    expect(process.exitCode).toBeUndefined();
    expect(await readEnv()).toEqual({ TOKEN: SECRET_VALUE });
    expect(log.info).toHaveBeenCalledWith("Not in teamStore\nABSENT");
  });

  it("fails naming the names when the store holds none of them", async () => {
    const { store } = teamStore();
    configure(store, { deploy: ["TOKEN"] });

    await handleSecretsPull();

    expect(process.exitCode).toBe(1);
    expect(log.error.mock.calls[0]?.[0]).toContain(
      "teamStore holds none of these:\nTOKEN\n",
    );
    expect(log.error.mock.calls[0]?.[0]).toContain("secrets import");
    await expect(fs.stat(envFile())).rejects.toThrow(/ENOENT/u);
  });

  it("exits 0 with a next step when the config names nothing and the store has no API key", async () => {
    const { store } = teamStore();
    configure(store);

    await handleSecretsPull();

    expect(process.exitCode).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      "The config names nothing to pull from teamStore.\nName secrets with --only.",
    );
    await expect(fs.stat(envFile())).rejects.toThrow(/ENOENT/u);
  });

  describe("--only", () => {
    it("pulls exactly its names, whether the config names them or not", async () => {
      const { store } = teamStore({
        TOKEN: SECRET_VALUE,
        EXTRA: "extra-value",
        HOT_UPDATER_API_KEY: "app-api-key",
      });
      configure(store, { deploy: ["TOKEN"] });

      await handleSecretsPull({ only: ["EXTRA"] });

      expect(process.exitCode).toBeUndefined();
      expect(store.get).toHaveBeenCalledWith(["EXTRA"], expect.anything());
      expect(await readEnv()).toEqual({ EXTRA: "extra-value" });
    });

    it("fails writing nothing when the store lacks one of its names", async () => {
      const { store } = teamStore({ TOKEN: SECRET_VALUE });
      configure(store);

      await handleSecretsPull({ only: ["TOKEN", "TYPO"] });

      expect(process.exitCode).toBe(1);
      expect(log.error).toHaveBeenCalledWith(
        "teamStore doesn't hold TYPO.\nCheck the names. Nothing was written.",
      );
      await expect(fs.stat(envFile())).rejects.toThrow(/ENOENT/u);
    });

    it("skips a build credential, by the config's name or a kind's, without reading it", async () => {
      const { store } = teamStore({
        "asc-api-key": "{}",
        "release-keystore": "{}",
      });
      configure(store, { build: ["release-keystore"] });

      await handleSecretsPull({ only: ["asc-api-key", "release-keystore"] });

      expect(process.exitCode).toBeUndefined();
      expect(store.get).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        [
          "Skipped asc-api-key and release-keystore.",
          "Builds read build credentials from the store.",
        ].join("\n"),
      );
      await expect(fs.stat(envFile())).rejects.toThrow(/ENOENT/u);
    });

    it.each([["NODE_OPTIONS"], ["asc-key-id"], ["INFISICAL_TOKEN"], ["PATH"]])(
      "refuses %s, a name that would take over a process or a credential",
      async (name) => {
        const { store } = teamStore({ [name]: "value" });
        configure(store);

        await handleSecretsPull({ only: [name] });

        expect(process.exitCode).toBe(1);
        expect(store.get).not.toHaveBeenCalled();
        expect(log.error.mock.calls[0]?.[0]).toContain(
          "can't go in an env file",
        );
      },
    );

    it("refuses two names that write one variable", async () => {
      const { store } = teamStore({ "a-b": "1", "a.b": "2" });
      configure(store);

      await handleSecretsPull({ only: ["a-b", "a.b"] });

      expect(process.exitCode).toBe(1);
      expect(store.get).not.toHaveBeenCalled();
      expect(log.error.mock.calls[0]?.[0]).toContain(
        "a-b and a.b both write HOT_UPDATER_A_B",
      );
    });

    it("refuses an empty list and an invalid name before loading the config", async () => {
      await handleSecretsPull({ only: [] });
      expect(log.error).toHaveBeenCalledWith(
        "--only takes secret names, comma-separated.",
      );

      await handleSecretsPull({ only: ["../evil"] });
      expect(log.error.mock.calls[1]?.[0]).toContain("is not a secret name");
      expect(loadConfig).not.toHaveBeenCalled();
    });
  });

  it("refuses a symlink, leaving its target as it is", async () => {
    const { store } = teamStore({ TOKEN: SECRET_VALUE });
    configure(store, { deploy: ["TOKEN"] });
    await fs.writeFile(envFile("real"), "KEEP=1\n");
    await fs.symlink(envFile("real"), envFile());

    await handleSecretsPull();

    expect(process.exitCode).toBe(1);
    expect(await fs.readFile(envFile("real"), "utf8")).toBe("KEEP=1\n");
    expect((await fs.lstat(envFile())).isSymbolicLink()).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      ".env.hotupdater isn't a regular file.\nPass another --out.",
    );
  });

  it("refuses a file it can't update, leaving it as it is", async () => {
    const { store } = teamStore({ TOKEN: SECRET_VALUE });
    configure(store, { deploy: ["TOKEN"] });
    // Node takes the key as `export\tTOKEN`, where the merge reads `TOKEN`.
    const content = "export\tTOKEN=1\n";
    await fs.writeFile(envFile(), content);

    await handleSecretsPull();

    expect(process.exitCode).toBe(1);
    expect(await fs.readFile(envFile(), "utf8")).toBe(content);
    expect(log.error).toHaveBeenCalledWith(
      "Can't update .env.hotupdater: it has a line this can't follow.\nFix its quoting, or pass another --out.",
    );
  });

  describe("git", () => {
    const warnings = () => log.warn.mock.calls.map(([message]) => message);

    it("warns when git doesn't ignore the file", async () => {
      git("init", "--quiet");
      const { store } = teamStore({ TOKEN: SECRET_VALUE });
      configure(store, { deploy: ["TOKEN"] });

      await handleSecretsPull();

      expect(warnings()).toEqual([
        ".env.hotupdater isn't gitignored.\nAdd it to .gitignore.",
      ]);
      expect(await readEnv()).toEqual({ TOKEN: SECRET_VALUE });
    });

    it("doesn't warn when git ignores it", async () => {
      git("init", "--quiet");
      await fs.writeFile(
        path.join(directory, ".gitignore"),
        ".env.hotupdater\n",
      );
      const { store } = teamStore({ TOKEN: SECRET_VALUE });
      configure(store, { deploy: ["TOKEN"] });

      await handleSecretsPull();

      expect(warnings()).toEqual([]);
    });

    it("warns that a tracked file is tracked, even when .gitignore lists it", async () => {
      git("init", "--quiet");
      await fs.writeFile(envFile(), "OTHER=1\n");
      git("add", ".env.hotupdater");
      await fs.writeFile(
        path.join(directory, ".gitignore"),
        ".env.hotupdater\n",
      );
      const { store } = teamStore({ TOKEN: SECRET_VALUE });
      configure(store, { deploy: ["TOKEN"] });

      await handleSecretsPull();

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain(".env.hotupdater is tracked by git.");
      expect(warnings()[0]).toContain("git rm --cached .env.hotupdater");
    });

    it("doesn't warn outside a work tree", async () => {
      const { store } = teamStore({ TOKEN: SECRET_VALUE });
      configure(store, { deploy: ["TOKEN"] });

      await handleSecretsPull();

      expect(warnings()).toEqual([]);
    });
  });

  it("reports an adapter's failed read, writing nothing", async () => {
    const { store } = teamStore();
    store.get.mockRejectedValueOnce(new Error("403 from the store"));
    configure(store, { deploy: ["TOKEN"] });

    await handleSecretsPull();

    expect(process.exitCode).toBe(1);
    expect(String(log.error.mock.calls[0]?.[0]).replace(/\s+/gu, " ")).toBe(
      "Couldn't read TOKEN and HOT_UPDATER_API_KEY from the teamStore secrets adapter. 403 from the store",
    );
    await expect(fs.stat(envFile())).rejects.toThrow(/ENOENT/u);
  });

  it("fits long names on an 80-column terminal, in each message", async () => {
    const long = (letter: string) => `HOT_UPDATER_${letter.repeat(52)}`;
    const names = [long("A"), long("B"), long("C")];
    const { store } = teamStore(
      Object.fromEntries(names.map((name) => [name, "store value"])),
    );
    const out = ".env.a-rather-long-file-name-for-this-project";
    configure(store, {
      deploy: names,
      build: [long("D"), long("E")],
    });
    await fs.writeFile(
      envFile(out),
      names.map((name) => `${name}=local`).join("\n"),
    );

    await handleSecretsPull({ out });
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    vi.mocked(nonInteractiveReason).mockReturnValue(undefined);
    confirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    git("init", "--quiet");
    await handleSecretsPull({ out });

    expect(process.exitCode).toBeUndefined();
    expect(log.success).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    await handleSecretsPull({ only: names.concat(long("F")) });
    expect(process.exitCode).toBe(1);
  });
});
