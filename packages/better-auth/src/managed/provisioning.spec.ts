import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOT_UPDATER_API_KEY_ENV_NAME,
  provisionManagedBetterAuthApiKey,
} from "./provisioning";

const fileSystemMock = vi.hoisted<{
  environmentOpenCount?: number;
  environmentOpenPath?: string;
  foreignOwnedAncestorPath?: string;
  chmodError?: unknown;
  closeError?: unknown;
  delayNextLockOwnerOpenMs?: number;
  lockOwnerUnlinkError?: unknown;
  partialWrite?: Readonly<{ bytes: number; error: unknown }>;
  replaceParentBeforeLock?: Readonly<{
    parentPath: string;
    relocatedPath: string;
    replacementPath: string;
  }>;
  replaceParentBeforeRealpath?: Readonly<{
    relocatedPath: string;
    replacementPath: string;
    requestedParentPath: string;
  }>;
  swapParentDuringEnvironmentOpen?: Readonly<{
    envFilePath: string;
    parentPath: string;
    relocatedPath: string;
    replacementPath: string;
  }>;
  truncateError?: unknown;
  uidOffset?: bigint;
}>(() => ({}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const filePath = String(args[0]);
      if (filePath === fileSystemMock.environmentOpenPath) {
        fileSystemMock.environmentOpenCount =
          (fileSystemMock.environmentOpenCount ?? 0) + 1;
      }
      if (
        filePath.includes(".lock/owner-") &&
        fileSystemMock.delayNextLockOwnerOpenMs !== undefined
      ) {
        const milliseconds = fileSystemMock.delayNextLockOwnerOpenMs;
        fileSystemMock.delayNextLockOwnerOpenMs = undefined;
        await new Promise((resolveDelay) => {
          setTimeout(resolveDelay, milliseconds);
        });
      }
      const swap = fileSystemMock.swapParentDuringEnvironmentOpen;
      const handle =
        swap !== undefined && filePath === swap.envFilePath
          ? await (async () => {
              fileSystemMock.swapParentDuringEnvironmentOpen = undefined;
              await actual.rename(swap.parentPath, swap.relocatedPath);
              await actual.symlink(
                swap.replacementPath,
                swap.parentPath,
                "dir",
              );
              try {
                return await actual.open(...args);
              } finally {
                await actual.unlink(swap.parentPath);
                await actual.rename(swap.relocatedPath, swap.parentPath);
              }
            })()
          : await actual.open(...args);
      if (filePath.includes(".lock/owner-")) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "chmod" && fileSystemMock.chmodError !== undefined) {
            return async () => {
              throw fileSystemMock.chmodError;
            };
          }
          if (property === "close" && fileSystemMock.closeError !== undefined) {
            return async () => {
              await target.close();
              throw fileSystemMock.closeError;
            };
          }
          if (
            property === "writeFile" &&
            fileSystemMock.partialWrite !== undefined
          ) {
            return async (content: string) => {
              const partialWrite = fileSystemMock.partialWrite;
              if (partialWrite === undefined) return;
              await target.writeFile(
                content.slice(0, partialWrite.bytes),
                "utf8",
              );
              throw partialWrite.error;
            };
          }
          if (
            property === "truncate" &&
            fileSystemMock.truncateError !== undefined
          ) {
            return async () => {
              throw fileSystemMock.truncateError;
            };
          }
          if (property === "stat" && fileSystemMock.uidOffset !== undefined) {
            return async (options: { bigint: true }) => {
              const stats = await target.stat(options);
              return new Proxy(stats, {
                get(statsTarget, statsProperty) {
                  if (statsProperty === "uid") {
                    return statsTarget.uid + (fileSystemMock.uidOffset ?? 0n);
                  }
                  const statsValue = Reflect.get(
                    statsTarget,
                    statsProperty,
                    statsTarget,
                  );
                  return typeof statsValue === "function"
                    ? statsValue.bind(statsTarget)
                    : statsValue;
                },
              });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    async lstat(...args: Parameters<typeof actual.lstat>) {
      const stats = await actual.lstat(...args);
      if (String(args[0]) !== fileSystemMock.foreignOwnedAncestorPath) {
        return stats;
      }
      return new Proxy(stats, {
        get(target, property) {
          if (property === "uid") {
            return typeof target.uid === "bigint"
              ? target.uid + 1n
              : target.uid + 1;
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    async realpath(...args: Parameters<typeof actual.realpath>) {
      const replacement = fileSystemMock.replaceParentBeforeRealpath;
      if (
        replacement === undefined ||
        String(args[0]) !== replacement.requestedParentPath
      ) {
        return actual.realpath(...args);
      }
      fileSystemMock.replaceParentBeforeRealpath = undefined;
      await actual.rename(
        replacement.requestedParentPath,
        replacement.relocatedPath,
      );
      await actual.symlink(
        replacement.replacementPath,
        replacement.requestedParentPath,
        "dir",
      );
      try {
        return await actual.realpath(...args);
      } finally {
        await actual.unlink(replacement.requestedParentPath);
        await actual.rename(
          replacement.relocatedPath,
          replacement.requestedParentPath,
        );
      }
    },
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      const replacement = fileSystemMock.replaceParentBeforeLock;
      if (replacement !== undefined && String(args[0]).endsWith(".lock")) {
        fileSystemMock.replaceParentBeforeLock = undefined;
        await actual.rename(replacement.parentPath, replacement.relocatedPath);
        await actual.symlink(
          replacement.replacementPath,
          replacement.parentPath,
          "dir",
        );
      }
      return actual.mkdir(...args);
    },
    async unlink(...args: Parameters<typeof actual.unlink>) {
      await actual.unlink(...args);
      if (
        String(args[0]).includes(".lock/owner-") &&
        fileSystemMock.lockOwnerUnlinkError !== undefined
      ) {
        throw fileSystemMock.lockOwnerUnlinkError;
      }
    },
  };
});

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "hot-updater-better-auth-")),
  );
  temporaryDirectories.push(directory);
  return directory;
};

const createTerminatedProvisioningLock = async (
  envFilePath: string,
  ownerCount: number,
): Promise<void> => {
  const source = [
    'const { mkdirSync, writeFileSync } = require("node:fs");',
    "const lockPath = process.argv[1];",
    "const ownerCount = Number(process.argv[2]);",
    "mkdirSync(lockPath, { mode: 0o700 });",
    "for (let index = 0; index < ownerCount; index += 1) {",
    '  const nonce = index.toString(16).padStart(32, "0");',
    '  writeFileSync(`${lockPath}/owner-${process.pid}-${nonce}`, "", { mode: 0o600 });',
    "}",
    'process.stdout.write("ready");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["-e", source, `${envFilePath}.lock`, String(ownerCount)],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (child.pid === undefined || child.stdout === null) {
    throw new Error("Failed to start lock-owner process.");
  }
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
};

afterEach(async () => {
  fileSystemMock.environmentOpenCount = undefined;
  fileSystemMock.environmentOpenPath = undefined;
  fileSystemMock.foreignOwnedAncestorPath = undefined;
  fileSystemMock.chmodError = undefined;
  fileSystemMock.closeError = undefined;
  fileSystemMock.delayNextLockOwnerOpenMs = undefined;
  fileSystemMock.lockOwnerUnlinkError = undefined;
  fileSystemMock.partialWrite = undefined;
  fileSystemMock.replaceParentBeforeLock = undefined;
  fileSystemMock.replaceParentBeforeRealpath = undefined;
  fileSystemMock.swapParentDuringEnvironmentOpen = undefined;
  fileSystemMock.truncateError = undefined;
  fileSystemMock.uidOffset = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("provisionManagedBetterAuthApiKey", () => {
  it("creates a canonical 32-byte key and its Better Auth hash projection", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");

    // When
    const result = await provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    expect(result.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.sha256).toBe(
      createHash("sha256").update(result.apiKey).digest("base64url"),
    );
    expect(await readFile(envFilePath, "utf8")).toBe(
      `${HOT_UPDATER_API_KEY_ENV_NAME}=${result.apiKey}\n`,
    );
  });

  it("preserves unrelated content and is byte-for-byte idempotent", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "# existing comment\nEXISTING=value\n";
    await writeFile(envFilePath, original, "utf8");

    // When
    const first = await provisionManagedBetterAuthApiKey({ envFilePath });
    const afterFirst = await readFile(envFilePath, "utf8");
    const second = await provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    expect(afterFirst.startsWith(original)).toBe(true);
    expect(second).toEqual(first);
    expect(await readFile(envFilePath, "utf8")).toBe(afterFirst);
  });

  it("does not expose a generated key through a pre-opened descriptor", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await writeFile(envFilePath, original, { encoding: "utf8", mode: 0o644 });
    const preopened = await open(envFilePath, "r");

    // When
    const result = await provisionManagedBetterAuthApiKey({ envFilePath });
    const retainedContent = await preopened.readFile("utf8");
    await preopened.close();

    // Then
    expect(retainedContent).toBe(original);
    expect(retainedContent).not.toContain(result.apiKey);
    expect(await readFile(envFilePath, "utf8")).toBe(
      `${original}${HOT_UPDATER_API_KEY_ENV_NAME}=${result.apiKey}\n`,
    );
    expect((await stat(envFilePath)).mode & 0o777).toBe(0o600);
  });

  it("serializes concurrent provisioning for an existing keyless env file", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await writeFile(envFilePath, original, "utf8");
    fileSystemMock.environmentOpenCount = 0;
    fileSystemMock.environmentOpenPath = envFilePath;

    // When
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        provisionManagedBetterAuthApiKey({ envFilePath }),
      ),
    );

    // Then
    expect(new Set(results.map((result) => result.apiKey))).toHaveLength(1);
    expect(new Set(results.map((result) => result.sha256))).toHaveLength(1);
    expect(fileSystemMock.environmentOpenCount).toBe(1);
    const content = await readFile(envFilePath, "utf8");
    expect(content.startsWith(original)).toBe(true);
    expect(
      content.match(new RegExp(`^${HOT_UPDATER_API_KEY_ENV_NAME}=`, "gmu")),
    ).toHaveLength(1);
  });

  it("rejects a symbolic-link environment path without changing its target", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const targetPath = join(directory, "target.env");
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await writeFile(targetPath, original, "utf8");
    await symlink(targetPath, envFilePath);

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toMatchObject({ code: "ELOOP" });
    expect(await readFile(targetPath, "utf8")).toBe(original);
  });

  it("rejects a non-root-owned symbolic link in the requested parent chain", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const targetParentPath = join(directory, "target");
    const requestedParentPath = join(directory, "requested");
    const targetEnvFilePath = join(targetParentPath, ".env.hotupdater");
    const requestedEnvFilePath = join(requestedParentPath, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await mkdir(targetParentPath, { mode: 0o700 });
    await writeFile(targetEnvFilePath, original, {
      encoding: "utf8",
      mode: 0o644,
    });
    const originalMode = (await stat(targetEnvFilePath)).mode & 0o777;
    await symlink(targetParentPath, requestedParentPath, "dir");

    // When
    const pending = provisionManagedBetterAuthApiKey({
      envFilePath: requestedEnvFilePath,
    });

    // Then
    await expect(pending).rejects.toThrow(
      "non-root-owned symbolic links in the requested directory chain",
    );
    expect(await readFile(targetEnvFilePath, "utf8")).toBe(original);
    expect((await stat(targetEnvFilePath)).mode & 0o777).toBe(originalMode);
  });

  it("rejects a parent directory replaced after its initial security check", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const parentPath = join(directory, "configuration");
    const relocatedPath = join(directory, "configuration-relocated");
    const replacementPath = join(directory, "replacement");
    const envFilePath = join(parentPath, ".env.hotupdater");
    const replacementEnvFilePath = join(replacementPath, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await mkdir(parentPath, { mode: 0o700 });
    await mkdir(replacementPath, { mode: 0o700 });
    await writeFile(replacementEnvFilePath, original, "utf8");
    fileSystemMock.replaceParentBeforeLock = {
      parentPath,
      relocatedPath,
      replacementPath,
    };

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow(
      "symbolic links in the environment directory chain",
    );
    expect(await readFile(replacementEnvFilePath, "utf8")).toBe(original);
    await expect(
      readFile(`${replacementEnvFilePath}.lock`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an ancestor owned by another non-root user", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const parentPath = join(directory, "configuration");
    const envFilePath = join(parentPath, ".env.hotupdater");
    await mkdir(parentPath, { mode: 0o700 });
    fileSystemMock.foreignOwnedAncestorPath = directory;

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow(
      "every requested-path ancestor to be owned by the effective user or root",
    );
    await expect(readFile(envFilePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a foreign-owned ancestor before it can redirect realpath", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const foreignParentPath = join(directory, "foreign");
    const requestedParentPath = join(foreignParentPath, "requested");
    const relocatedPath = join(foreignParentPath, "requested-relocated");
    const replacementPath = join(directory, "replacement");
    const envFilePath = join(requestedParentPath, ".env.hotupdater");
    const replacementEnvFilePath = join(replacementPath, ".env.hotupdater");
    const redirected = "REDIRECTED=value\n";
    await mkdir(foreignParentPath, { mode: 0o755 });
    await mkdir(requestedParentPath, { mode: 0o700 });
    await mkdir(replacementPath, { mode: 0o700 });
    await writeFile(replacementEnvFilePath, redirected, {
      encoding: "utf8",
      mode: 0o644,
    });
    const redirectedMode = (await stat(replacementEnvFilePath)).mode & 0o777;
    fileSystemMock.foreignOwnedAncestorPath = foreignParentPath;
    fileSystemMock.replaceParentBeforeRealpath = {
      relocatedPath,
      replacementPath,
      requestedParentPath,
    };

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow(
      "every requested-path ancestor to be owned by the effective user or root",
    );
    expect(fileSystemMock.replaceParentBeforeRealpath).toBeDefined();
    expect(await readFile(replacementEnvFilePath, "utf8")).toBe(redirected);
    expect((await stat(replacementEnvFilePath)).mode & 0o777).toBe(
      redirectedMode,
    );
  });

  it("does not mutate a redirected file opened during a parent swap", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const parentPath = join(directory, "configuration");
    const relocatedPath = join(directory, "configuration-relocated");
    const replacementPath = join(directory, "replacement");
    const envFilePath = join(parentPath, ".env.hotupdater");
    const replacementEnvFilePath = join(replacementPath, ".env.hotupdater");
    const original = "ORIGINAL=value\n";
    const redirected = "REDIRECTED=value\n";
    await mkdir(parentPath, { mode: 0o700 });
    await mkdir(replacementPath, { mode: 0o700 });
    await writeFile(envFilePath, original, { encoding: "utf8", mode: 0o600 });
    await writeFile(replacementEnvFilePath, redirected, {
      encoding: "utf8",
      mode: 0o644,
    });
    const redirectedMode = (await stat(replacementEnvFilePath)).mode & 0o777;
    fileSystemMock.swapParentDuringEnvironmentOpen = {
      envFilePath,
      parentPath,
      relocatedPath,
      replacementPath,
    };

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow(
      "environment path changed during provisioning",
    );
    expect(await readFile(envFilePath, "utf8")).toBe(original);
    expect(await readFile(replacementEnvFilePath, "utf8")).toBe(redirected);
    expect((await stat(replacementEnvFilePath)).mode & 0o777).toBe(
      redirectedMode,
    );
  });

  it("rejects a hard-linked environment path without changing its target", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const targetPath = join(directory, "target.env");
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await writeFile(targetPath, original, "utf8");
    await link(targetPath, envFilePath);

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow("single hard link");
    expect(await readFile(targetPath, "utf8")).toBe(original);
  });

  it("reclaims a lock left by a terminated provisioning process", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    await createTerminatedProvisioningLock(envFilePath, 1);

    // When
    const result = await provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    expect(result.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(readFile(`${envFilePath}.lock`, "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("serializes simultaneous reclaimers of the same terminated lock", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    await createTerminatedProvisioningLock(envFilePath, 2);

    // When
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        provisionManagedBetterAuthApiKey({ envFilePath }),
      ),
    );

    // Then
    expect(new Set(results.map((result) => result.apiKey))).toHaveLength(1);
    const content = await readFile(envFilePath, "utf8");
    expect(
      content.match(new RegExp(`^${HOT_UPDATER_API_KEY_ENV_NAME}=`, "gmu")),
    ).toHaveLength(1);
    await expect(readFile(`${envFilePath}.lock`, "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("does not enter through a lock directory replaced during delayed initialization", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    fileSystemMock.delayNextLockOwnerOpenMs = 100;

    // When
    const delayed = provisionManagedBetterAuthApiKey({ envFilePath });
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 20);
    });
    const competing = provisionManagedBetterAuthApiKey({ envFilePath });
    const results = await Promise.all([delayed, competing]);

    // Then
    expect(new Set(results.map((result) => result.apiKey))).toHaveLength(1);
    expect(
      (await readFile(envFilePath, "utf8")).match(
        new RegExp(`^${HOT_UPDATER_API_KEY_ENV_NAME}=`, "gmu"),
      ),
    ).toHaveLength(1);
  });

  it("rejects an environment file owned by another user", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await writeFile(envFilePath, original, "utf8");
    fileSystemMock.uidOffset = 1n;

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow("user-owned regular file");
    expect(await readFile(envFilePath, "utf8")).toBe(original);
  });

  it("rejects a group-writable provisioning directory", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    await chmod(directory, 0o770);

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow(
      "not writable by group or other users",
    );
    await expect(readFile(envFilePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    "short",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
  ])(
    "rejects an invalid existing key %# without replacing it",
    async (value) => {
      // Given
      const directory = await createTemporaryDirectory();
      const envFilePath = join(directory, ".env.hotupdater");
      const original = `${HOT_UPDATER_API_KEY_ENV_NAME}=${value}\n`;
      await writeFile(envFilePath, original, "utf8");

      // When
      const pending = provisionManagedBetterAuthApiKey({ envFilePath });

      // Then
      await expect(pending).rejects.toThrow(HOT_UPDATER_API_KEY_ENV_NAME);
      expect(await readFile(envFilePath, "utf8")).toBe(original);
    },
  );

  it("does not write a new key when an existing env file cannot be secured", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await writeFile(envFilePath, original, "utf8");
    fileSystemMock.chmodError = Object.assign(new Error("permission denied"), {
      code: "EPERM",
    });

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow("permission denied");
    expect(await readFile(envFilePath, "utf8")).toBe(original);
  });

  it.each(["ENOSYS", "ENOTSUP", "EOPNOTSUPP"])(
    "rejects unsupported permission hardening for an existing env file (%s)",
    async (code) => {
      // Given
      const directory = await createTemporaryDirectory();
      const envFilePath = join(directory, ".env.hotupdater");
      const original = "EXISTING=value\n";
      await writeFile(envFilePath, original, "utf8");
      fileSystemMock.chmodError = Object.assign(
        new Error("permission hardening unsupported"),
        { code },
      );

      // When
      const pending = provisionManagedBetterAuthApiKey({ envFilePath });

      // Then
      await expect(pending).rejects.toMatchObject({ code });
      expect(await readFile(envFilePath, "utf8")).toBe(original);
    },
  );

  it("does not write a generated key when a new env file cannot be secured", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    fileSystemMock.chmodError = Object.assign(
      new Error("permission hardening unsupported"),
      { code: "ENOTSUP" },
    );

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toMatchObject({ code: "ENOTSUP" });
    expect(await readFile(envFilePath, "utf8")).toBe("");
  });

  it("restores an existing env file when an append fails after a partial write", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await writeFile(envFilePath, original, "utf8");
    fileSystemMock.partialWrite = {
      bytes: 8,
      error: new Error("partial append failed"),
    };

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow("partial append failed");
    expect(await readFile(envFilePath, "utf8")).toBe(original);
  });

  it("preserves a provisioning error when environment cleanup also fails", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await writeFile(envFilePath, original, "utf8");
    const permissionError = new Error("permission hardening failed");
    const closeError = new Error("close failed");
    fileSystemMock.chmodError = permissionError;
    fileSystemMock.closeError = closeError;

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    const error = await pending.then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error("Expected an AggregateError.");
    }
    expect(error.cause).toBe(permissionError);
    expect(error.errors).toEqual(
      expect.arrayContaining([permissionError, closeError]),
    );
    expect(await readFile(envFilePath, "utf8")).toBe(original);
  });

  it("reports a failed rollback together with the partial append error", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "EXISTING=value\n";
    const appendError = new Error("partial append failed");
    const rollbackError = new Error("rollback failed");
    await writeFile(envFilePath, original, "utf8");
    fileSystemMock.partialWrite = { bytes: 8, error: appendError };
    fileSystemMock.truncateError = rollbackError;

    // When
    const error = await provisionManagedBetterAuthApiKey({ envFilePath }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    // Then
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error("Expected an AggregateError.");
    }
    expect(error.cause).toBe(appendError);
    expect(error.errors).toEqual(
      expect.arrayContaining([appendError, rollbackError]),
    );
    expect(await readFile(envFilePath, "utf8")).toBe(original);
  });

  it("reports lock cleanup failure together with the provisioning error", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const lockCleanupError = new Error("lock owner unlink failed");
    await writeFile(
      envFilePath,
      `${HOT_UPDATER_API_KEY_ENV_NAME}=invalid\n`,
      "utf8",
    );
    fileSystemMock.lockOwnerUnlinkError = lockCleanupError;

    // When
    const error = await provisionManagedBetterAuthApiKey({ envFilePath }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    // Then
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error("Expected an AggregateError.");
    }
    expect(error.errors).toEqual(expect.arrayContaining([lockCleanupError]));
    expect(error.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(HOT_UPDATER_API_KEY_ENV_NAME),
        }),
      ]),
    );
  });

  it("rejects an oversized environment file without modifying it", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "a".repeat(1_048_577);
    await writeFile(envFilePath, original, "utf8");

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow("exceeds the 1 MiB");
    expect(await readFile(envFilePath, "utf8")).toBe(original);
  });

  it("rejects Windows before creating an environment or lock file", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow("owner-only file permissions");
    await expect(readFile(envFilePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(`${envFilePath}.lock`, "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});
